import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { createServer } from "net";
import type { Config, TransportClient, IncomingAttachment, IncomingMessage } from "./types.js";

const MAX_MESSAGE_LENGTH = 6000;
const SEND_TIMEOUT = 30_000;
const WS_PORT_BASE = 5225;
const SEEN_MAX_AGE = 5 * 60_000; // prune dedup entries older than 5 minutes

// SimpleX CLI binary location
const SIMPLEX_BIN_DIR = resolve(homedir(), ".snoot", "simplex");
const SIMPLEX_BIN_PATH = resolve(SIMPLEX_BIN_DIR, "simplex-chat");

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[simplex] ${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Returns true for transient errors worth retrying (timeouts, connection issues) */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out|timeout|ECONNREFUSED|ECONNRESET|ENETUNREACH|WebSocket|connection|network/i.test(msg);
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const RETRY_DELAYS = [5, 15, 30, 60];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await withTimeout(fn(), SEND_TIMEOUT, label);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt >= RETRY_DELAYS.length) throw err;
      const delay = RETRY_DELAYS[attempt];
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[simplex] ${label} failed (${msg}), retrying in ${delay}s (attempt ${attempt + 1}/${RETRY_DELAYS.length})...`);
      await Bun.sleep(delay * 1000);
    }
  }
  throw lastErr;
}

/** Check if SimpleX CLI binary is installed */
export function isSimplexInstalled(): boolean {
  return existsSync(SIMPLEX_BIN_PATH);
}

/** Download and install SimpleX CLI binary */
export async function installSimplexCli(): Promise<void> {
  mkdirSync(SIMPLEX_BIN_DIR, { recursive: true });

  const platform = process.platform;
  const arch = process.arch;

  let assetName: string;
  if (platform === "linux") {
    if (arch === "x64") {
      assetName = "simplex-chat-ubuntu-24_04-x86_64";
    } else if (arch === "arm64") {
      assetName = "simplex-chat-ubuntu-24_04-aarch64";
    } else {
      throw new Error(`Unsupported Linux architecture: ${arch}`);
    }
  } else if (platform === "darwin") {
    if (arch === "arm64") {
      assetName = "simplex-chat-macos-aarch64";
    } else {
      assetName = "simplex-chat-macos-x86-64";
    }
  } else if (platform === "win32") {
    assetName = "simplex-chat-windows-x86-64";
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  // Get latest release tag
  console.log("[simplex] Fetching latest release info...");
  const releaseResp = await fetch("https://api.github.com/repos/simplex-chat/simplex-chat/releases/latest");
  if (!releaseResp.ok) throw new Error(`Failed to fetch release info: ${releaseResp.status}`);
  const release = await releaseResp.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const tag = release.tag_name;

  const asset = release.assets.find((a: { name: string }) => a.name === assetName);
  if (!asset) {
    // Fall back to ubuntu 22.04 if 24.04 not available
    const fallbackName = assetName.replace("24_04", "22_04");
    const fallbackAsset = release.assets.find((a: { name: string }) => a.name === fallbackName);
    if (!fallbackAsset) {
      throw new Error(`No binary found for ${platform}/${arch} in release ${tag}. Available: ${release.assets.map((a: { name: string }) => a.name).join(", ")}`);
    }
    console.log(`[simplex] Using fallback: ${fallbackName}`);
    await downloadBinary(fallbackAsset.browser_download_url, tag);
  } else {
    await downloadBinary(asset.browser_download_url, tag);
  }
}

async function downloadBinary(url: string, tag: string): Promise<void> {
  console.log(`[simplex] Downloading SimpleX Chat CLI ${tag}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  writeFileSync(SIMPLEX_BIN_PATH, data);
  try { chmodSync(SIMPLEX_BIN_PATH, 0o755); } catch {}
  console.log(`[simplex] Installed SimpleX Chat CLI ${tag} to ${SIMPLEX_BIN_PATH}`);
}

interface SimplexIdentity {
  contactId: number | null; // resolved after user accepts connection
  wsPort: number;
  displayName: string;
}

/** Generate a preferred WS port for this channel based on the channel name */
function channelPortPreferred(channel: string): number {
  let hash = 0;
  for (let i = 0; i < channel.length; i++) {
    hash = ((hash << 5) - hash + channel.charCodeAt(i)) | 0;
  }
  return WS_PORT_BASE + (Math.abs(hash) % 1000);
}

/** Check if a port is available */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => { srv.close(() => resolve(true)); });
    srv.listen(port, "127.0.0.1");
  });
}

/** Get a free port, starting from the preferred one */
async function channelPort(channel: string): Promise<number> {
  const preferred = channelPortPreferred(channel);
  if (await isPortFree(preferred)) return preferred;
  // Try up to 20 alternatives
  for (let i = 1; i <= 20; i++) {
    const alt = preferred + i;
    if (await isPortFree(alt)) {
      console.log(`[simplex] Port ${preferred} in use, using ${alt}`);
      return alt;
    }
  }
  throw new Error(`[simplex] Could not find free port near ${preferred}`);
}

export async function createSimplexClient(config: Config): Promise<TransportClient> {
  const simplexDir = `${config.baseDir}/simplex_data`;
  mkdirSync(simplexDir, { recursive: true });

  const identityFile = `${config.baseDir}/simplex_identity.json`;
  const wsPort = await channelPort(config.channel);

  let identity: SimplexIdentity;
  if (existsSync(identityFile)) {
    identity = JSON.parse(readFileSync(identityFile, "utf-8"));
    identity.wsPort = wsPort; // always use computed port
  } else {
    identity = { contactId: null, wsPort: wsPort, displayName: config.channel };
  }

  // Deduplication and startup filtering state
  const startedAt = Date.now();
  const seenChatItemIds = new Map<string, number>(); // chatItemId → time first seen

  // Periodically prune old dedup entries
  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - SEEN_MAX_AGE;
    for (const [id, seenAt] of seenChatItemIds) {
      if (seenAt < cutoff) seenChatItemIds.delete(id);
    }
  }, 60_000);
  if (pruneTimer.unref) pruneTimer.unref();

  // Start the SimpleX CLI as a WebSocket server
  const cliPath = SIMPLEX_BIN_PATH;
  if (!existsSync(cliPath)) {
    throw new Error("SimpleX CLI not found. Run: snoot setup simplex <your-address>");
  }

  console.log(`[simplex] Starting CLI on ws://localhost:${wsPort} (db: ${simplexDir})`);

  const cliProc = Bun.spawn([cliPath, "-p", String(wsPort), "-d", simplexDir], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });

  // Wait for the CLI to be ready (it prints to stdout when ready)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SimpleX CLI failed to start within 15s")), 15_000);

    // Also try connecting to the WebSocket as the readiness signal
    const tryConnect = async () => {
      for (let i = 0; i < 30; i++) {
        try {
          const testWs = new WebSocket(`ws://localhost:${wsPort}`);
          await new Promise<void>((res, rej) => {
            testWs.onopen = () => { testWs.close(); res(); };
            testWs.onerror = () => rej(new Error("ws connect failed"));
          });
          clearTimeout(timeout);
          resolve();
          return;
        } catch {
          await Bun.sleep(500);
        }
      }
      clearTimeout(timeout);
      reject(new Error("Could not connect to SimpleX CLI WebSocket"));
    };
    tryConnect();
  });

  console.log(`[simplex] CLI started, connecting WebSocket...`);

  let ws: WebSocket;
  let corrIdCounter = 0;
  let wsReady = false; // tracks whether the WebSocket is open and usable
  const pendingCommands = new Map<string, { resolve: (resp: any) => void; reject: (err: Error) => void }>();
  let onMessageCallback: ((msg: IncomingMessage) => void) | null = null;
  let cliDead = false;

  // Pending file download resolvers: fileId → resolve callback
  const pendingFileDownloads = new Map<number, { resolve: (path: string) => void; reject: (err: Error) => void }>();

  // Escalating reconnect backoff (seconds) — matches Session's pattern
  const RECONNECT_DELAYS = [5, 10, 15, 30, 30, 60, 60, 60, 120, 120, 300];
  let reconnectAttempt = 0;

  // Watch for CLI process death
  cliProc.exited.then((code) => {
    if (cliDead) return; // already handled
    cliDead = true;
    console.error(`[simplex] CLI process exited with code ${code} — shutting down`);
    // Reject all pending commands
    for (const [id, handler] of pendingCommands) {
      handler.reject(new Error("[simplex] CLI process died"));
      pendingCommands.delete(id);
    }
    // Exit the snoot process — the supervisor/daemon will restart it
    process.exit(1);
  });

  function nextCorrId(): string {
    return String(++corrIdCounter);
  }

  async function connectWs(): Promise<void> {
    return new Promise<void>((resolveConnect, rejectConnect) => {
      if (cliDead) {
        rejectConnect(new Error("[simplex] CLI process is dead, cannot connect"));
        return;
      }

      ws = new WebSocket(`ws://localhost:${wsPort}`);

      ws.onopen = () => {
        console.log(`[simplex] WebSocket connected to port ${wsPort}`);
        wsReady = true;
        reconnectAttempt = 0; // reset backoff on successful connect
        resolveConnect();
      };

      ws.onerror = (ev: Event) => {
        console.error(`[simplex] WebSocket error`);
        wsReady = false;
        rejectConnect(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        wsReady = false;
        if (cliDead) return; // don't reconnect if CLI is dead
        const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        reconnectAttempt++;
        console.log(`[simplex] WebSocket closed, reconnecting in ${delay}s (attempt ${reconnectAttempt})...`);
        setTimeout(() => connectWs().catch(err => console.error("[simplex] Reconnect failed:", err)), delay * 1000);
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(String(event.data));
          const corrId = data.corrId;

          // If this is a response to a command we sent
          if (corrId && pendingCommands.has(corrId)) {
            const handler = pendingCommands.get(corrId)!;
            pendingCommands.delete(corrId);
            if (data.resp?.type === "chatCmdError") {
              handler.reject(new Error(JSON.stringify(data.resp.chatError)));
            } else {
              handler.resolve(data.resp);
            }
            return;
          }

          // Async event (no corrId or unmatched)
          handleEvent(data.resp || data);
        } catch (err) {
          console.error("[simplex] Failed to parse WS message:", err);
        }
      };
    });
  }

  function handleEvent(resp: any): void {
    if (!resp?.type) return;

    switch (resp.type) {
      case "contactConnected": {
        const contact = resp.contact;
        if (contact) {
          console.log(`[simplex] Contact connected: ${contact.profile?.displayName || contact.contactId}`);
          // Save contact ID if this is our user
          identity.contactId = contact.contactId;
          writeFileSync(identityFile, JSON.stringify(identity, null, 2));
        }
        break;
      }

      case "newChatItems": {
        if (!onMessageCallback) return;
        for (const item of (resp.chatItems || [])) {
          const chatItem = item.chatItem;
          const chatInfo = item.chatInfo;
          if (!chatItem || !chatInfo) continue;

          // Only accept direct messages
          if (chatInfo.type !== "direct") continue;

          // Only accept from our known contact
          if (identity.contactId && chatInfo.contact?.contactId !== identity.contactId) continue;

          // Skip messages from before this session started
          const itemTs = chatItem.meta?.createdAt ? new Date(chatItem.meta.createdAt).getTime() : 0;
          if (itemTs > 0 && itemTs < startedAt) continue;

          // Deduplicate by chat item ID
          const itemId = String(chatItem.chatItemId || chatItem.meta?.itemId || itemTs);
          if (seenChatItemIds.has(itemId)) continue;
          seenChatItemIds.set(itemId, Date.now());

          // Extract text content — only from received messages (not our own sends)
          const content = chatItem.content;
          let text = "";
          if (content?.type === "rcvMsgContent") {
            const msgContent = content.msgContent;
            if (msgContent?.type === "text") {
              text = msgContent.text || "";
            } else if (msgContent?.type === "file" || msgContent?.type === "image") {
              text = msgContent.text || "";
            }
          }

          // Handle file attachments
          const attachments: IncomingAttachment[] = [];
          if (chatItem.file) {
            attachments.push({
              id: String(chatItem.file.fileId || ""),
              contentType: chatItem.file.fileMeta?.contentType,
              name: chatItem.file.fileName,
              size: chatItem.file.fileSize,
              _raw: chatItem.file,
            });
          }

          if (text || attachments.length > 0) {
            // Update contact ID if we didn't have it
            if (!identity.contactId && chatInfo.contact?.contactId) {
              identity.contactId = chatInfo.contact.contactId;
              writeFileSync(identityFile, JSON.stringify(identity, null, 2));
              console.log(`[simplex] Resolved contact ID: ${identity.contactId}`);
            }
            onMessageCallback({ text, attachments });
          }
        }
        break;
      }

      case "rcvFileComplete": {
        const fileId = resp.chatItem?.file?.fileId || resp.fileTransferMeta?.fileId;
        const filePath = resp.chatItem?.file?.filePath || resp.fileTransferMeta?.filePath;
        console.log(`[simplex] File received: ${resp.fileName || "unknown"} (id=${fileId})`);
        if (fileId && pendingFileDownloads.has(fileId)) {
          const handler = pendingFileDownloads.get(fileId)!;
          pendingFileDownloads.delete(fileId);
          if (filePath) {
            handler.resolve(filePath);
          } else {
            handler.resolve(`${simplexDir}/files/${resp.fileName || "file"}`);
          }
        }
        break;
      }

      case "contactRequest": {
        // Auto-accept contact requests
        const contactReq = resp.contactRequest;
        if (contactReq) {
          console.log(`[simplex] Auto-accepting contact request from ${contactReq.profile?.displayName || "unknown"}`);
          sendCmd(`/ac ${contactReq.contactRequestId}`).catch(err =>
            console.error("[simplex] Failed to accept contact request:", err)
          );
        }
        break;
      }
    }
  }

  function sendCmd(cmd: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!wsReady || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`[simplex] WebSocket not connected (state=${ws?.readyState})`));
        return;
      }

      const corrId = nextCorrId();
      const timeout = setTimeout(() => {
        pendingCommands.delete(corrId);
        reject(new Error(`[simplex] Command timed out: ${cmd.slice(0, 50)}`));
      }, SEND_TIMEOUT);

      pendingCommands.set(corrId, {
        resolve: (resp: any) => { clearTimeout(timeout); resolve(resp); },
        reject: (err: Error) => { clearTimeout(timeout); reject(err); },
      });

      ws.send(JSON.stringify({ corrId, cmd }));
    });
  }

  // Connect the WebSocket
  await connectWs();

  // Ensure there's an active user profile
  try {
    const userResp = await sendCmd("/u");
    if (!userResp || userResp.type === "chatCmdError") {
      console.log(`[simplex] Creating user profile: ${identity.displayName}`);
      await sendCmd(`/u ${identity.displayName}`);
    } else {
      console.log(`[simplex] Active user: ${userResp.user?.profile?.displayName || identity.displayName}`);
    }
  } catch {
    console.log(`[simplex] Creating user profile: ${identity.displayName}`);
    try {
      await sendCmd(`/u ${identity.displayName}`);
    } catch (err) {
      console.error("[simplex] Failed to create user profile:", err);
    }
  }

  // Connect to the user's SimpleX address if we don't have a contact yet
  if (!identity.contactId && config.userId) {
    console.log(`[simplex] Sending connection request to user address...`);
    try {
      await sendCmd(`/c ${config.userId}`);
      console.log(`[simplex] Connection request sent. Waiting for user to accept...`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If already connected or pending, that's fine
      if (!msg.includes("duplicate") && !msg.includes("already")) {
        console.error(`[simplex] Connection request failed:`, err);
      } else {
        console.log(`[simplex] Connection already exists or pending`);
      }
    }
  }

  // Save identity
  writeFileSync(identityFile, JSON.stringify(identity, null, 2));
  try { chmodSync(identityFile, 0o600); } catch {}

  // Clean up CLI process on exit
  process.on("exit", () => {
    try { cliProc.kill(); } catch {}
  });
  process.on("SIGTERM", () => {
    try { cliProc.kill(); } catch {}
  });
  process.on("SIGINT", () => {
    try { cliProc.kill(); } catch {}
  });

  async function startListening(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    onMessageCallback = onMessage;
    console.log(`[simplex] Listening on channel "${config.channel}" (ws port ${wsPort})`);
    console.log(`[simplex] Accepting messages from contact ID: ${identity.contactId ?? "pending"}`);
  }

  async function send(text: string): Promise<void> {
    if (!identity.contactId) {
      // Wait up to 60s for the contact to be established (user accepting connection)
      console.log("[simplex] Waiting for contact to accept connection before sending...");
      const waitStart = Date.now();
      while (!identity.contactId && Date.now() - waitStart < 60_000) {
        await Bun.sleep(2000);
      }
      if (!identity.contactId) {
        console.error("[simplex] Cannot send — no contact connected after 60s");
        return;
      }
      console.log(`[simplex] Contact established (id=${identity.contactId}), sending`);
    }

    // Use /send @<contactId> text <msg> format for sending by numeric ID
    const sendPrefix = `/send @${identity.contactId} text `;

    // Chunk long messages
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await withRetry(() => sendCmd(`${sendPrefix}${text}`), "send");
      return;
    }

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
      await withRetry(() => sendCmd(`${sendPrefix}${prefix}${chunks[i]}`), "send-chunk");
    }
  }

  async function sendImage(png: Uint8Array, caption?: string): Promise<void> {
    if (!identity.contactId) {
      console.log("[simplex] Waiting for contact before sending image...");
      const waitStart = Date.now();
      while (!identity.contactId && Date.now() - waitStart < 60_000) {
        await Bun.sleep(2000);
      }
      if (!identity.contactId) {
        console.error("[simplex] Cannot send image — no contact connected after 60s");
        return;
      }
    }
    // Write to temp file and send via CLI
    const tmpPath = `${simplexDir}/tmp_send_image.png`;
    writeFileSync(tmpPath, png);
    try {
      await withRetry(() => sendCmd(`/f @${identity.contactId} ${tmpPath}`), "sendImage");
      if (caption) {
        await withRetry(() => sendCmd(`/send @${identity.contactId} text ${caption}`), "sendImageCaption");
      }
    } finally {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    }
  }

  async function sendFile(filePath: string, caption?: string): Promise<void> {
    if (!identity.contactId) {
      console.log("[simplex] Waiting for contact before sending file...");
      const waitStart = Date.now();
      while (!identity.contactId && Date.now() - waitStart < 60_000) {
        await Bun.sleep(2000);
      }
      if (!identity.contactId) {
        console.error("[simplex] Cannot send file — no contact connected after 60s");
        return;
      }
    }
    const absPath = resolve(filePath);
    await withRetry(() => sendCmd(`/f @${identity.contactId} ${absPath}`), "sendFile");
    if (caption) {
      await withRetry(() => sendCmd(`/send @${identity.contactId} text ${caption}`), "sendFileCaption");
    }
  }

  async function setAvatar(_png: Uint8Array): Promise<void> {
    // SimpleX CLI doesn't support programmatic avatar setting the same way
    // Store it locally for reference
    const avatarCache = `${config.baseDir}/avatar.png`;
    writeFileSync(avatarCache, _png);
    console.log(`[simplex] Avatar cached (setting profile images not yet supported via CLI)`);
  }

  async function reuploadAvatar(): Promise<void> {
    // No-op for SimpleX — avatars are handled differently
  }

  async function getFile(attachment: IncomingAttachment): Promise<File> {
    const raw = attachment._raw as any;
    const fileId = raw?.fileId;
    if (!fileId) throw new Error("No fileId in SimpleX attachment");

    // Wait for the rcvFileComplete event with a timeout
    const filePathPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFileDownloads.delete(fileId);
        reject(new Error(`[simplex] File download timed out after 30s (fileId=${fileId})`));
      }, 30_000);
      pendingFileDownloads.set(fileId, {
        resolve: (path: string) => { clearTimeout(timeout); resolve(path); },
        reject: (err: Error) => { clearTimeout(timeout); reject(err); },
      });
    });

    // Request file download
    await sendCmd(`/fr ${fileId}`);

    // Wait for the event
    const downloadPath = await filePathPromise;

    if (existsSync(downloadPath)) {
      const data = readFileSync(downloadPath);
      return new File([data.buffer as ArrayBuffer], attachment.name || "file");
    }

    // Fallback: try common path
    const fallbackPath = `${simplexDir}/files/${attachment.name || raw.fileName || "file"}`;
    if (existsSync(fallbackPath)) {
      const data = readFileSync(fallbackPath);
      return new File([data.buffer as ArrayBuffer], attachment.name || "file");
    }

    throw new Error("Could not find downloaded SimpleX file");
  }

  function getIdentity(): string {
    return `simplex:${wsPort}:${identity.contactId ?? "pending"}`;
  }

  return { startListening, send, sendImage, sendFile, setAvatar, reuploadAvatar, getFile, getIdentity };
}
