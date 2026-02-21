import { Session, Poller, ready } from "@session.js/client";
import { generateSeedHex } from "@session.js/keypair";
import { encode } from "@session.js/mnemonic";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Config, SessionClient } from "./types.js";

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

  // Restore cached avatar if available
  const avatarCache = `${config.baseDir}/avatar.png`;
  if (existsSync(avatarCache)) {
    try {
      const png = readFileSync(avatarCache);
      await session.setAvatar(new Uint8Array(png));
      console.log("[session] Restored cached avatar");
    } catch (err) {
      console.error("[session] Failed to restore avatar:", err);
    }
  }

  function startListening(onMessage: (text: string) => void): void {
    const startedAt = Date.now();
    const seenTimestamps = new Set<number>();

    session.addPoller(new Poller());

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

      const text = message.text;
      if (text) {
        onMessage(text);
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
    // Persist so avatar survives restarts
    const avatarCache = `${config.baseDir}/avatar.png`;
    writeFileSync(avatarCache, png);
    console.log(`[session] Avatar cached to ${avatarCache}`);
  }

  function getSessionId(): string {
    return identity.sessionId;
  }

  return { startListening, send, sendImage, setAvatar, getSessionId };
}
