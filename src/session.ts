import { Session, Poller, ready } from "@session.js/client";
import { generateSeedHex } from "@session.js/keypair";
import { encode } from "@session.js/mnemonic";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Config, SessionClient, IncomingAttachment, IncomingMessage } from "./types.js";

const MAX_MESSAGE_LENGTH = 6000;
const RETRY_DELAY = 30_000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const name = err?.constructor?.name ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    // Retry once on network-level errors
    if (name.includes("Fetch") || name.includes("Network") || msg.includes("fetch") || msg.includes("network")) {
      console.error(`[session] ${label} failed (${name}), retrying in 30s...`);
      await Bun.sleep(RETRY_DELAY);
      return await fn();
    }
    throw err;
  }
}

interface Identity {
  mnemonic: string;
  sessionId: string;
  displayName: string;
}

export async function createSessionClient(config: Config): Promise<SessionClient> {
  await ready;

  const identityFile = `${config.baseDir}/identity.json`;
  let identity: Identity;

  if (existsSync(identityFile)) {
    identity = JSON.parse(readFileSync(identityFile, "utf-8"));
  } else {
    mkdirSync(config.baseDir, { recursive: true });
    const mnemonic = encode(generateSeedHex());
    const tempSession = new Session();
    tempSession.setMnemonic(mnemonic, config.channel);
    const sessionId = tempSession.getSessionID();
    identity = { mnemonic, sessionId, displayName: config.channel };
    writeFileSync(identityFile, JSON.stringify(identity, null, 2));
    console.log(`Created identity for channel "${config.channel}"`);
    console.log(`Session ID: ${sessionId}`);
  }

  const session = new Session();
  session.setMnemonic(identity.mnemonic, identity.displayName);

  // Restore cached avatar metadata directly onto the session instance.
  // This makes the avatar URL+key available immediately so the very first
  // outgoing message includes avatar info (no re-upload needed).
  const avatarMetaPath = `${config.baseDir}/avatar-meta.json`;
  if (existsSync(avatarMetaPath)) {
    try {
      const { key, url } = JSON.parse(readFileSync(avatarMetaPath, "utf-8"));
      (session as any).avatar = { key: new Uint8Array(key), url };
      console.log(`[session] Avatar metadata restored from cache`);
    } catch (err) {
      console.error(`[session] Failed to restore avatar metadata:`, err);
    }
  }

  function startListening(onMessage: (msg: IncomingMessage) => void): void {
    const startedAt = Date.now();
    const seenTimestamps = new Set<number>();

    session.addPoller(new Poller());

    // Re-upload avatar in background so the file server URL stays fresh.
    // The metadata restore above covers the immediate need (first messages),
    // this ensures the URL doesn't expire over longer periods.
    const avatarCache = `${config.baseDir}/avatar.png`;
    if (existsSync(avatarCache)) {
      setTimeout(async () => {
        try {
          const png = readFileSync(avatarCache);
          await session.setAvatar(new Uint8Array(png));
          // Update cached metadata with fresh URL
          const avatar = (session as any).avatar;
          if (avatar) {
            writeFileSync(avatarMetaPath, JSON.stringify({
              key: Array.from(avatar.key),
              url: avatar.url,
            }));
          }
          console.log(`[session] Avatar re-uploaded and metadata refreshed`);
        } catch (err) {
          console.error(`[session] Background avatar re-upload failed:`, err);
        }
      }, 10000);
    }

    session.on("message", (message: any) => {
      // Only accept messages from the configured user
      if (message.from !== config.userSessionId) {
        return;
      }

      const ts: number | undefined = message.timestamp;
      if (!ts) return;

      // Skip messages from before this session started
      if (ts < startedAt) {
        return;
      }

      // Deduplicate by sender timestamp (stable across redeliveries)
      if (seenTimestamps.has(ts)) {
        return;
      }
      seenTimestamps.add(ts);

      const text = message.text || "";
      const rawAttachments: any[] = message.attachments || [];
      const attachments: IncomingAttachment[] = rawAttachments.map((a: any) => ({
        id: a.id,
        contentType: a.metadata?.contentType,
        name: a.name,
        size: a.size,
        _raw: a,
      }));

      // Accept if there's text or attachments
      if (text || attachments.length > 0) {
        onMessage({ text, attachments });
      }
    });

    console.log(`Listening on channel "${config.channel}" (${identity.sessionId})`);
    console.log(`Accepting messages from: ${config.userSessionId}`);
  }

  async function send(text: string): Promise<void> {
    // Chunk long messages
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await withRetry(() => session.sendMessage({
        to: config.userSessionId,
        text,
      }), "send");
      return;
    }

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      // Try to split at a newline near the limit
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
      await withRetry(() => session.sendMessage({
        to: config.userSessionId,
        text: prefix + chunks[i],
      }), "send-chunk");
    }
  }

  async function sendImage(png: Uint8Array, caption?: string): Promise<void> {
    const file = new File([png.buffer as ArrayBuffer], "image.png", { type: "image/png" });
    await withRetry(() => session.sendMessage({
      to: config.userSessionId,
      text: caption,
      attachments: [file],
    }), "sendImage");
  }

  async function setAvatar(png: Uint8Array): Promise<void> {
    await withRetry(() => session.setAvatar(png), "setAvatar");
    // Persist PNG so we can re-upload later
    const avatarCache = `${config.baseDir}/avatar.png`;
    writeFileSync(avatarCache, png);
    // Persist URL + key so first message after restart includes avatar
    const avatar = (session as any).avatar;
    if (avatar) {
      writeFileSync(avatarMetaPath, JSON.stringify({
        key: Array.from(avatar.key),
        url: avatar.url,
      }));
    }
    console.log(`[session] Avatar cached (png + metadata)`);
  }

  async function reuploadAvatar(): Promise<void> {
    const avatarCache = `${config.baseDir}/avatar.png`;
    if (!existsSync(avatarCache)) return;
    try {
      const png = readFileSync(avatarCache);
      await session.setAvatar(new Uint8Array(png));
      const avatar = (session as any).avatar;
      if (avatar) {
        writeFileSync(avatarMetaPath, JSON.stringify({
          key: Array.from(avatar.key),
          url: avatar.url,
        }));
      }
      console.log(`[session] Avatar re-uploaded before greeting`);
    } catch (err) {
      console.error(`[session] Avatar re-upload failed:`, err);
    }
  }

  async function getFile(attachment: IncomingAttachment): Promise<File> {
    return await session.getFile(attachment._raw as any);
  }

  function getSessionId(): string {
    return identity.sessionId;
  }

  return { startListening, send, sendImage, setAvatar, reuploadAvatar, getFile, getSessionId };
}
