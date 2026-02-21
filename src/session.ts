import { Session, Poller, ready } from "@session.js/client";
import { generateSeedHex } from "@session.js/keypair";
import { encode } from "@session.js/mnemonic";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Config, SessionClient } from "./types.js";

const MAX_MESSAGE_LENGTH = 6000;

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
      await session.sendMessage({
        to: config.userSessionId,
        text,
      });
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
      await session.sendMessage({
        to: config.userSessionId,
        text: prefix + chunks[i],
      });
    }
  }

  function getSessionId(): string {
    return identity.sessionId;
  }

  return { startListening, send, getSessionId };
}
