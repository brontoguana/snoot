import { join, resolve, extname } from "path";
import { existsSync, writeFileSync, appendFileSync, readFileSync, watch as fsWatch } from "fs";
import type { Config, LLMManager, Backend, IncomingMessage, IncomingAttachment } from "./types.js";
import { createSessionClient } from "./session.js";
import { createClaudeManager } from "./claude.js";
import { createGeminiManager } from "./gemini.js";
import { createContextStore } from "./context.js";
import { handleCommand } from "./commands.js";
import { buildProfilePrompt, convertAvatarSvg, svgToPng, extractSvgBlocks } from "./profile.js";

function createLLM(config: Config): LLMManager {
  return config.backend === "gemini"
    ? createGeminiManager(config)
    : createClaudeManager(config);
}

export function createProxy(config: Config) {
  const context = createContextStore(config);
  let llm: LLMManager = createLLM(config);
  let sessionClient: Awaited<ReturnType<typeof createSessionClient>>;
  let processing = false;
  let processingStartedAt = 0;
  const PROCESSING_TIMEOUT = 5 * 60_000; // 5 minutes — force-reset if stuck
  let messageQueue: string[] = [];
  let shuttingDown = false;
  let pendingAvatar = false;
  type BufferEntry = { type: "text"; content: string } | { type: "tool"; content: string };
  let chunkBuffer: BufferEntry[] = [];
  let textCharsSent = 0;
  const FLUSH_INTERVAL = 30_000;

  const avatarSvgPath = join(config.baseDir, "avatar.svg");
  const watchLogPath = join(config.baseDir, "watch.log");

  // Truncate watch log on startup so it only shows the current session
  writeFileSync(watchLogPath, "");

  function watchLog(line: string): void {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    appendFileSync(watchLogPath, `${time}  ${line}\n`);
  }

  /** Send a response that may contain inline SVG blocks as images */
  async function sendRichResponse(text: string): Promise<void> {
    const segments = extractSvgBlocks(text);

    // No SVGs found — send as plain text
    if (segments.length === 1 && segments[0].type === "text") {
      await sessionClient.send(segments[0].content);
      return;
    }
    if (segments.length === 0) return;

    for (const segment of segments) {
      if (segment.type === "text") {
        await sessionClient.send(segment.content);
      } else {
        try {
          const png = svgToPng(segment.content);
          await sessionClient.sendImage(png);
          console.log(`[proxy] Sent inline SVG as PNG (${png.length} bytes)`);
        } catch (err) {
          console.error("[proxy] Failed to convert inline SVG:", err);
          await sessionClient.send("[Image failed to render]");
        }
      }
    }
  }

  function wireLLMCallbacks(): void {
    llm.onRateLimit(async (retryIn, attempt) => {
      watchLog(`⏳ Rate limited — retrying in ${retryIn}s (attempt ${attempt}/5)`);
      try {
        await sessionClient.send(`⏳ Rate limited — retrying in ${retryIn}s (attempt ${attempt}/5)`);
      } catch {}
    });

    llm.onApiError(async (retryIn, attempt, maxAttempts) => {
      watchLog(`⚠️ API error (500) — retrying in ${retryIn}s (attempt ${attempt}/${maxAttempts})`);
      try {
        if (attempt <= maxAttempts) {
          await sessionClient.send(`⚠️ API error (500) — retrying in ${retryIn}s (attempt ${attempt}/${maxAttempts})`);
        }
      } catch {}
    });

    llm.onChunk((text) => {
      chunkBuffer.push({ type: "text", content: text });
      // Stream LLM output to watch log in real-time
      const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const logLines = text.split('\n').map(l => `${time}  │ ${l}\n`).join('');
      appendFileSync(watchLogPath, logLines);
    });

    llm.onActivity((line) => {
      watchLog(line);
      // Capture tool calls into buffer for user messages
      if (line.startsWith("🔧")) {
        chunkBuffer.push({ type: "tool", content: line });
      }
    });

    llm.onExit(async () => {
      if (shuttingDown) return;
      // If we're not currently processing a message, this is an unexpected exit
      // (e.g. Claude was killed externally). Notify the user.
      if (!processing) {
        watchLog("⚠️ LLM process exited unexpectedly");
      }
    });
  }

  async function switchBackend(backend: Backend): Promise<string> {
    if (config.backend === backend) {
      return `Already using ${backend}.`;
    }
    if (llm.isAlive()) await llm.kill();
    config.backend = backend;
    llm = createLLM(config);
    wireLLMCallbacks();
    return `Switched to ${backend}. Next message will use ${backend}.`;
  }

  async function start(): Promise<void> {
    try {
      await context.load();
    } catch (err) {
      console.error("[proxy] Failed to load context, starting fresh:", err);
    }
    sessionClient = await createSessionClient(config);

    wireLLMCallbacks();

    sessionClient.startListening(onMessage);
    console.log(`[proxy] Ready. Mode: ${config.mode}, Backend: ${config.backend}`);
    watchLog(`🟢 Snoot online — ${config.backend} / ${config.mode} / ${config.workDir}`);

    // Wait for session to connect, then re-upload avatar before greeting
    await new Promise(r => setTimeout(r, 3000));
    await sessionClient.reuploadAvatar();

    // Greet the user so the conversation appears in their Session app
    await sessionClient.send(
      `✅ Snoot is online. Backend: ${config.backend}. Mode: ${config.mode}. Working dir: ${config.workDir}\nSend /help for commands.`
    );

    // Watch inbox for terminal input (from snoot watch)
    const inboxPath = join(config.baseDir, "inbox");
    writeFileSync(inboxPath, "");
    let inboxOffset = 0;

    fsWatch(inboxPath, () => {
      try {
        const content = readFileSync(inboxPath, "utf-8");
        if (content.length <= inboxOffset) return;
        const newContent = content.slice(inboxOffset);
        inboxOffset = content.length;
        for (const line of newContent.split("\n")) {
          if (!line.trim()) continue;
          try {
            const { text } = JSON.parse(line);
            if (text) onMessage({ text, attachments: [] });
          } catch {}
        }
      } catch {}
    });
  }

  function onMessage(msg: IncomingMessage): void {
    const trimmed = msg.text.trim();

    // Log all incoming messages to watch
    const logText = trimmed || (msg.attachments.length > 0 ? `[${msg.attachments.length} attachment(s)]` : "");
    watchLog(`← ${logText.slice(0, 1000)}${logText.length > 1000 ? "..." : ""}`);

    // /save and /overwrite with attachment — save file to working directory
    const saveMatch = trimmed.match(/^\/(save|overwrite)\s+(.+)/i);
    if (saveMatch && msg.attachments.length > 0) {
      const allowOverwrite = saveMatch[1].toLowerCase() === "overwrite";
      handleSaveFile(saveMatch[2].trim(), msg.attachments[0], allowOverwrite);
      return;
    }

    // /profile with image attachment — set avatar directly, no LLM needed
    if (trimmed.match(/^\/profile\s*$/i) && msg.attachments.length > 0) {
      // Use first attachment — don't require contentType since session.js may not provide it
      handleProfileImage(msg.attachments[0]);
      return;
    }

    // /claude and /gemini — switch backend (bypass queue)
    if (trimmed.toLowerCase() === "/claude" || trimmed.toLowerCase() === "/gemini") {
      const backend = trimmed.toLowerCase().slice(1) as Backend;
      watchLog(`🔄 Switching to ${backend}`);
      switchBackend(backend).then(msg => sessionClient.send(msg).catch(() => {}));
      return;
    }

    // All slash commands bypass the queue so they respond even while LLM is busy
    // Exception: /profile <desc> goes to the LLM for avatar generation
    if (trimmed.startsWith("/") && !trimmed.match(/^\/profile\s+/i)) {
      handleCommandDirect(msg.text);
      return;
    }

    messageQueue.push(msg.text);

    // Watchdog: if processing has been stuck for too long, force-reset
    if (processing && processingStartedAt > 0 && Date.now() - processingStartedAt > PROCESSING_TIMEOUT) {
      const stuckFor = Math.round((Date.now() - processingStartedAt) / 1000);
      console.error(`[proxy] Processing stuck for ${stuckFor}s — force-resetting`);
      watchLog(`⚠️ Processing stuck for ${stuckFor}s — force-resetting`);
      processing = false;
    }

    if (!processing) {
      processQueue();
    }
  }

  async function handleProfileImage(attachment: IncomingAttachment): Promise<void> {
    watchLog(`🖼️ Setting avatar from attached image`);
    try {
      const file = await sessionClient.getFile(attachment);
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      await sessionClient.setAvatar(bytes);
      await sessionClient.send("Avatar updated!");
      console.log(`[proxy] Avatar set from attachment (${bytes.length} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[proxy] Avatar from attachment failed:", err);
      try { await sessionClient.send(`Avatar failed: ${msg}`); } catch {}
    }
  }

  function detectImageExtension(contentType?: string, fileName?: string): string | null {
    if (contentType) {
      const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
      };
      if (map[contentType]) return map[contentType];
    }
    // Fallback: try extension from the attachment's original filename
    if (fileName) {
      const match = fileName.match(/\.(\w+)$/);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  async function handleSaveFile(name: string, attachment: IncomingAttachment, allowOverwrite: boolean): Promise<void> {
    const verb = allowOverwrite ? "Overwriting" : "Saving";
    watchLog(`💾 ${verb} file as "${name}"`);
    try {
      const file = await sessionClient.getFile(attachment);
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);

      // If name has no extension and it's an image, autodetect extension
      let filename = name;
      if (!extname(filename)) {
        const ext = detectImageExtension(attachment.contentType, file.name);
        if (ext) {
          filename = `${filename}.${ext}`;
        }
      }

      // Prevent path traversal
      const savePath = resolve(config.workDir, filename);
      if (!savePath.startsWith(resolve(config.workDir))) {
        await sessionClient.send("Invalid filename — cannot save outside working directory.");
        return;
      }

      if (!allowOverwrite && existsSync(savePath)) {
        await sessionClient.send(`File "${filename}" already exists. Use /overwrite ${name} to replace it.`);
        return;
      }

      writeFileSync(savePath, bytes);
      await sessionClient.send(`Saved "${filename}" (${bytes.length} bytes)`);
      console.log(`[proxy] Saved file: ${savePath} (${bytes.length} bytes)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[proxy] Save file failed:", err);
      try { await sessionClient.send(`Save failed: ${errMsg}`); } catch {}
    }
  }

  async function handleCommandDirect(text: string): Promise<void> {
    const cmdResult = handleCommand(text, config, context, llm);
    if (!cmdResult) return;

    const cmd = text.trim().toLowerCase();
    if (cmd === "/forget" || cmd === "/clear") {
      watchLog(`🗑️ Clearing context`);
      if (llm.isAlive()) await llm.kill();
      await context.reset();
    } else {
      if (cmdResult.restartProcess) {
        watchLog(`🔄 Restarting snoot`);
        if (llm.isAlive()) await llm.kill();
        await sessionClient.send(cmdResult.response);
        Bun.spawn(process.argv, {
          cwd: process.cwd(),
          env: process.env,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
        }).unref();
        process.exit(0);
        return;
      }
      if (cmdResult.killProcess && llm.isAlive()) {
        watchLog(`🛑 Stopping process`);
        await llm.kill();
      }
      if (cmdResult.triggerCompaction) {
        watchLog(`📦 Compacting context`);
        await context.compact();
      }
    }

    try {
      await sessionClient.send(cmdResult.response);
    } catch {}
  }

  async function processQueue(): Promise<void> {
    processing = true;
    processingStartedAt = Date.now();

    while (messageQueue.length > 0) {
      // Drain and batch all queued messages (commands are handled outside the queue)
      const messages: string[] = [];
      while (messageQueue.length > 0) {
        messages.push(messageQueue.shift()!);
      }

      const batched = messages.length === 1
        ? messages[0]
        : messages.join("\n\n");

      if (messages.length > 1) {
        console.log(`[proxy] Batched ${messages.length} messages into one request`);
      }

      try {
        await handleMessage(batched);
      } catch (err) {
        console.error("[proxy] Error handling message:", err);
        try {
          await sessionClient.send(
            `Error: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        } catch {
          console.error("[proxy] Failed to send error message");
        }
      }
    }

    processing = false;
    processingStartedAt = 0;
  }

  /** Promise that resolves when any in-progress flush completes */
  let flushInProgress: Promise<void> = Promise.resolve();

  /** Flush chunk buffer: group entries into messages (each starts with text, followed by tool calls) */
  async function flushChunkBuffer(): Promise<void> {
    // Chain flushes so concurrent calls are serialized
    const previous = flushInProgress;
    let resolve!: () => void;
    flushInProgress = new Promise<void>((r) => { resolve = r; });
    // Wait for previous flush, but don't wait forever (prevents deadlock if prior flush hung)
    await Promise.race([previous, new Promise<void>(r => setTimeout(r, 60_000))]);
    if (chunkBuffer.length === 0) { resolve(); return; }

    try {
      const entries = chunkBuffer.splice(0);

      // Group entries: each text entry starts a new message group, tools append to current group
      const groups: string[][] = [];
      for (const entry of entries) {
        if (entry.type === "text") {
          groups.push([entry.content]);
          textCharsSent += entry.content.length;
        } else {
          // Tool call — append to last group, or create new one if none exists
          if (groups.length === 0) groups.push([]);
          groups[groups.length - 1].push(entry.content);
        }
      }

      // Collapse consecutive identical tool lines within each group (e.g. "🔧 Read foo.ts (x4)")
      for (const group of groups) {
        const collapsed: string[] = [];
        for (const line of group) {
          if (line.startsWith("🔧") && collapsed.length > 0) {
            const prev = collapsed[collapsed.length - 1];
            // Check if previous line is the same tool call (with or without existing count)
            const prevMatch = prev.match(/^(.+?)( \(x(\d+)\))?$/);
            if (prevMatch && prevMatch[1] === line) {
              const count = prevMatch[3] ? parseInt(prevMatch[3]) + 1 : 2;
              collapsed[collapsed.length - 1] = `${line} (x${count})`;
              continue;
            }
          }
          collapsed.push(line);
        }
        group.length = 0;
        group.push(...collapsed);
      }

      // Send each group as a separate Session message
      for (const group of groups) {
        const msg = group.join("\n").trim();
        if (msg) {
          try { await sendRichResponse(msg); } catch {}
        }
      }
    } finally {
      resolve();
    }
  }

  async function handleMessage(text: string): Promise<void> {
    console.log(`[proxy] Received: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

    // Handle /profile — transform into a Claude message
    const profileMatch = text.trim().match(/^\/profile\s+(.+)/i);
    if (profileMatch) {
      pendingAvatar = true;
      const prompt = buildProfilePrompt(profileMatch[1], avatarSvgPath);
      text = prompt;
      // Fall through to normal Claude handling below
    }

    // Check for /commands
    const cmdResult = handleCommand(text, config, context, llm);
    if (cmdResult) {
      // Handle /forget and /clear specially — reset context before sending response
      const cmd = text.trim().toLowerCase();
      if (cmd === "/forget" || cmd === "/clear") {
        if (llm.isAlive()) await llm.kill();
        await context.reset();
      } else {
        if (cmdResult.restartProcess) {
          if (llm.isAlive()) await llm.kill();
          await sessionClient.send(cmdResult.response);
          // Re-exec with same args — new process acquires the lock
          Bun.spawn(process.argv, {
            cwd: process.cwd(),
            env: process.env,
            stdout: "inherit",
            stderr: "inherit",
            stdin: "ignore",
          }).unref();
          process.exit(0);
          return;
        }
        if (cmdResult.killProcess && llm.isAlive()) {
          await llm.kill();
        }
        if (cmdResult.triggerCompaction) {
          await context.compact();
        }
      }

      await sessionClient.send(cmdResult.response);
      return;
    }

    // Regular message — build full context and spawn fresh process
    const promptFile = context.buildPrompt();
    chunkBuffer = [];
    textCharsSent = 0;
    llm.send(text, promptFile);

    // Send "thinking" indicators
    const backendName = config.backend === "gemini" ? "Gemini" : "Claude";
    const thinkingTimer = setTimeout(async () => {
      if (llm.isAlive()) {
        try { await sessionClient.send("💭 thinking..."); } catch {}
      }
    }, 5_000);
    // Flush accumulated chunks every 30s
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    flushTimer = setInterval(async () => {
      await flushChunkBuffer();
    }, FLUSH_INTERVAL);

    // Wait for response
    const response = await llm.waitForResponse();
    clearTimeout(thinkingTimer);
    if (flushTimer) clearInterval(flushTimer);

    // Post-response phase: flush, record, send.
    // All Session sends already have a 30s timeout (session.ts), so individual
    // sends can't hang forever.  Wrap the whole block in try/catch so a send
    // failure doesn't leave `processing` stuck.
    try {
      // Flush any remaining entries in the buffer
      await flushChunkBuffer();

      // Empty response — tell the user (only if nothing was streamed)
      if (!response && textCharsSent === 0 && chunkBuffer.length === 0) {
        console.log(`[proxy] ${backendName} returned empty response`);
        await sessionClient.send(`${backendName} returned an empty response — it may have hit a limit. Try again.`);
        return;
      }

      // If this was a /profile request, check for the SVG file and set avatar
      if (pendingAvatar) {
        pendingAvatar = false;
        try {
          if (existsSync(avatarSvgPath)) {
            const png = await convertAvatarSvg(avatarSvgPath);
            await sessionClient.setAvatar(png);
            await sessionClient.send("Avatar updated!");
            console.log(`[proxy] Avatar set (${png.length} bytes)`);
          } else {
            await sessionClient.send("Avatar generation failed: SVG file was not created.");
            console.error("[proxy] Avatar SVG not found at", avatarSvgPath);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error("[proxy] Avatar conversion failed:", err);
          try { await sessionClient.send(`Avatar failed: ${msg}`); } catch {}
        }
        return;
      }

      // Record the exchange in context (text only, strip SVGs)
      const fullResponse = response || "";
      const contextResponse = fullResponse.replace(/<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>[\s\S]*?<\/svg>/g, "[image]");
      const pair = {
        id: context.nextPairId(),
        user: text,
        assistant: contextResponse,
        timestamp: Date.now(),
      };
      await context.append(pair);

      // Check if compaction is needed after recording the exchange
      if (context.needsCompaction()) {
        console.log("[proxy] Compaction threshold reached, compacting...");
        await context.compact();
      }

      // If nothing was streamed yet, send the full response now
      if (textCharsSent === 0 && response) {
        watchLog(`→ Sending response (${response.length} chars)`);
        await sendRichResponse(response);
      } else {
        watchLog(`→ Response streamed (${textCharsSent} chars)`);
      }

      // Notify the user that the LLM has finished
      try { await sessionClient.send("✅ Finished"); } catch {}
    } catch (err) {
      console.error("[proxy] Post-response error:", err);
      watchLog(`⚠️ Post-response error: ${err instanceof Error ? err.message : err}`);
      // Try to notify user, but don't let this block either
      try { await sessionClient.send("⚠️ Error delivering response. Send another message to retry."); } catch {}
    }
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    console.log("\n[proxy] Shutting down...");

    if (llm.isAlive()) {
      await llm.kill();
    }

    console.log("[proxy] Goodbye.");
    process.exit(0);
  }

  return { start, shutdown };
}
