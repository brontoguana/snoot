import * as sdk from "matrix-js-sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { basename, extname } from "path";
import type { Config, TransportClient, IncomingAttachment, IncomingMessage } from "./types.js";

const MAX_MESSAGE_LENGTH = 6000;
const SEND_TIMEOUT = 30_000;
const SYNC_TIMEOUT = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[matrix] ${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const RETRY_DELAYS = [5, 15, 30, 60];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await withTimeout(fn(), SEND_TIMEOUT, label);
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_DELAYS.length) throw err;
      const delay = RETRY_DELAYS[attempt];
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[matrix] ${label} failed (${msg}), retrying in ${delay}s (attempt ${attempt + 1}/${RETRY_DELAYS.length})...`);
      await Bun.sleep(delay * 1000);
    }
  }
  throw lastErr;
}

interface MatrixIdentity {
  userId: string;
  accessToken: string;
  deviceId: string;
  homeserver: string;
  roomId?: string;
}

export async function createMatrixClient(config: Config): Promise<TransportClient> {
  if (!config.matrixConfig) {
    throw new Error("Matrix config is required when transport is 'matrix'");
  }

  const matrixDir = `${config.baseDir}/matrix`;
  mkdirSync(matrixDir, { recursive: true });
  const identityFile = `${matrixDir}/identity.json`;
  const roomFile = `${matrixDir}/room.json`;

  let identity: MatrixIdentity;

  // Load or create identity
  if (existsSync(identityFile)) {
    identity = JSON.parse(readFileSync(identityFile, "utf-8"));
  } else {
    // We need an access token — try to use one from config, or error
    if (!config.matrixConfig.accessToken) {
      throw new Error(
        "No Matrix access token. Run: snoot setup matrix <@user:server> --homeserver <url>\n" +
        "The setup will prompt for a password to obtain an access token."
      );
    }
    // Validate the token by doing a whoami
    const tempClient = sdk.createClient({
      baseUrl: config.matrixConfig.homeserver,
      accessToken: config.matrixConfig.accessToken,
    });
    let whoami: { user_id: string; device_id?: string };
    try {
      whoami = await tempClient.whoami();
    } catch (err) {
      throw new Error(`Matrix token invalid: ${err instanceof Error ? err.message : err}`);
    }
    identity = {
      userId: whoami.user_id,
      accessToken: config.matrixConfig.accessToken,
      deviceId: whoami.device_id || "SNOOT",
      homeserver: config.matrixConfig.homeserver,
    };
    writeFileSync(identityFile, JSON.stringify(identity, null, 2));
    try { chmodSync(identityFile, 0o600); } catch {}
    console.log(`[matrix] Saved identity for ${identity.userId}`);
    tempClient.stopClient();
  }

  // Create the real client
  const client = sdk.createClient({
    baseUrl: identity.homeserver,
    accessToken: identity.accessToken,
    userId: identity.userId,
    deviceId: identity.deviceId,
  });

  // Room management: get or create a DM room for this channel
  let roomId: string;

  if (existsSync(roomFile)) {
    const roomData = JSON.parse(readFileSync(roomFile, "utf-8"));
    roomId = roomData.roomId;
  } else if (config.matrixConfig.roomId) {
    roomId = config.matrixConfig.roomId;
    writeFileSync(roomFile, JSON.stringify({ roomId }));
  } else {
    // Create a private room for this channel and invite the user
    const room = await client.createRoom({
      name: `Snoot: ${config.channel}`,
      topic: `Snoot proxy channel "${config.channel}"`,
      visibility: "private" as any,
      invite: [config.userId],
      is_direct: true,
      preset: "trusted_private_chat" as any,
    });
    roomId = room.room_id;
    writeFileSync(roomFile, JSON.stringify({ roomId }));
    console.log(`[matrix] Created room ${roomId} for channel "${config.channel}"`);
  }

  // Avatar handling
  let avatarMxcUrl: string | null = null;
  const avatarMetaPath = `${config.baseDir}/avatar-meta.json`;
  if (existsSync(avatarMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(avatarMetaPath, "utf-8"));
      if (meta.mxcUrl) avatarMxcUrl = meta.mxcUrl;
    } catch {}
  }

  async function startListening(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    const startedAt = Date.now();
    const seenEvents = new Set<string>();

    client.on(sdk.RoomEvent.Timeline as any, (event: any, room: any) => {
      // Only handle messages in our room, from the user
      if (room?.roomId !== roomId) return;
      if (event.getType() !== "m.room.message") return;
      if (event.getSender() !== config.userId) return;

      const eventId = event.getId();
      if (seenEvents.has(eventId)) return;
      seenEvents.add(eventId);

      // Skip messages from before we started
      const ts = event.getTs();
      if (ts < startedAt) return;

      const content = event.getContent();
      const text = content.body || "";
      const attachments: IncomingAttachment[] = [];

      // Handle file/image attachments
      if (content.msgtype === "m.image" || content.msgtype === "m.file") {
        const url = content.url; // mxc:// URL
        attachments.push({
          id: eventId,
          contentType: content.info?.mimetype,
          name: content.body,
          size: content.info?.size,
          _raw: { url, info: content.info, client },
        });
      }

      if (text || attachments.length > 0) {
        onMessage({ text, attachments });
      }
    });

    // Start syncing
    await client.startClient({ initialSyncLimit: 0 });

    // Wait for first sync to complete
    await new Promise<void>((resolve) => {
      client.once(sdk.ClientEvent.Sync as any, (state: string) => {
        if (state === "PREPARED") resolve();
      });
    });

    console.log(`Listening on Matrix room ${roomId}`);
    console.log(`Accepting messages from: ${config.userId}`);
  }

  async function send(text: string): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await withRetry(() => client.sendTextMessage(roomId, text), "send");
      return;
    }

    // Chunk long messages
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = MAX_MESSAGE_LENGTH;
      if (remaining.length > MAX_MESSAGE_LENGTH) {
        const lastNewline = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
        if (lastNewline > MAX_MESSAGE_LENGTH * 0.5) {
          splitAt = lastNewline + 1;
        }
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }

    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
      await withRetry(() => client.sendTextMessage(roomId, prefix + chunks[i]), "send-chunk");
    }
  }

  async function sendImage(png: Uint8Array, caption?: string): Promise<void> {
    // Upload the image to Matrix content repository
    const uploaded = await withRetry(
      () => client.uploadContent(new Blob([png.buffer as ArrayBuffer], { type: "image/png" }), { name: "image.png" }),
      "upload-image"
    );
    const mxcUrl = typeof uploaded === "string" ? uploaded : (uploaded as any).content_uri;

    await withRetry(() => client.sendMessage(roomId, {
      msgtype: "m.image",
      body: caption || "image.png",
      url: mxcUrl,
      info: {
        mimetype: "image/png",
        size: png.length,
      },
    } as any), "sendImage");
  }

  async function sendFile(filePath: string, caption?: string): Promise<void> {
    const data = readFileSync(filePath);
    const name = basename(filePath);
    const ext = extname(filePath).slice(1).toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      pdf: "application/pdf", txt: "text/plain", json: "application/json",
      csv: "text/csv", xml: "text/xml", html: "text/html",
      zip: "application/zip",
    };
    const mimeType = mimeTypes[ext] || "application/octet-stream";
    const isImage = mimeType.startsWith("image/");

    const uploaded = await withRetry(
      () => client.uploadContent(new Blob([data], { type: mimeType }), { name }),
      "upload-file"
    );
    const mxcUrl = typeof uploaded === "string" ? uploaded : (uploaded as any).content_uri;

    await withRetry(() => client.sendMessage(roomId, {
      msgtype: isImage ? "m.image" : "m.file",
      body: caption || name,
      url: mxcUrl,
      info: {
        mimetype: mimeType,
        size: data.length,
      },
    } as any), "sendFile");
  }

  async function setAvatar(png: Uint8Array): Promise<void> {
    // Upload as Matrix content
    const uploaded = await withRetry(
      () => client.uploadContent(new Blob([png.buffer as ArrayBuffer], { type: "image/png" }), { name: "avatar.png" }),
      "upload-avatar"
    );
    const mxcUrl = typeof uploaded === "string" ? uploaded : (uploaded as any).content_uri;
    avatarMxcUrl = mxcUrl;

    // Set as room avatar
    await withRetry(() => client.sendStateEvent(roomId, "m.room.avatar" as any, { url: mxcUrl }, ""), "set-avatar");

    // Also set as profile avatar
    try {
      await client.setAvatarUrl(mxcUrl);
    } catch {}

    // Persist locally
    const avatarCache = `${config.baseDir}/avatar.png`;
    writeFileSync(avatarCache, png);
    writeFileSync(avatarMetaPath, JSON.stringify({ mxcUrl }));
    console.log(`[matrix] Avatar set (mxc: ${mxcUrl})`);
  }

  async function reuploadAvatar(): Promise<void> {
    const avatarCache = `${config.baseDir}/avatar.png`;
    if (!existsSync(avatarCache)) return;
    try {
      const png = readFileSync(avatarCache);
      await setAvatar(new Uint8Array(png));
      console.log(`[matrix] Avatar re-uploaded`);
    } catch (err) {
      console.error(`[matrix] Avatar re-upload failed:`, err);
    }
  }

  async function getFile(attachment: IncomingAttachment): Promise<File> {
    const raw = attachment._raw as { url: string; info?: any; client: any };
    // Convert mxc:// URL to HTTP URL
    const httpUrl = client.mxcUrlToHttp(raw.url);
    if (!httpUrl) throw new Error(`Cannot resolve mxc URL: ${raw.url}`);

    const response = await fetch(httpUrl);
    if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
    const buf = await response.arrayBuffer();
    const mimeType = attachment.contentType || "application/octet-stream";
    const name = attachment.name || "file";
    return new File([buf], name, { type: mimeType });
  }

  function getIdentity(): string {
    return identity.userId;
  }

  return { startListening, send, sendImage, sendFile, setAvatar, reuploadAvatar, getFile, getIdentity };
}
