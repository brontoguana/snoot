import { join } from "path";
import { existsSync, writeFileSync, appendFileSync } from "fs";
import type { Config, LLMManager, Backend } from "./types.js";
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
  let messageQueue: string[] = [];
  let shuttingDown = false;
  let pendingAvatar = false;
  let chunkBuffer = "";
  let chunksSent = 0;
  // Progressive flush schedule: 30s for first minute, 60s for next 3 min, 120s after that
  const FLUSH_SCHEDULE = [
    { until: 60_000, interval: 30_000 },   // first minute: every 30s
    { until: 240_000, interval: 60_000 },   // 1-4 min: every 60s
    { until: Infinity, interval: 120_000 }, // 4+ min: every 2 min
  ];

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
      chunkBuffer += text;
      // Stream LLM output to watch log in real-time
      const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const logLines = text.split('\n').map(l => `${time}  │ ${l}\n`).join('');
      appendFileSync(watchLogPath, logLines);
    });

    llm.onActivity((line) => {
      watchLog(line);
    });

    llm.onExit(async () => {
      if (shuttingDown) return;
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

    // Greet the user so the conversation appears in their Session app
    await sessionClient.send(
      `Snoot is online. Backend: ${config.backend}. Mode: ${config.mode}. Working dir: ${config.workDir}\nSend /help for commands.`
    );
  }

  function onMessage(text: string): void {
    const trimmed = text.trim();

    // Log all incoming messages to watch
    watchLog(`← ${trimmed.slice(0, 1000)}${trimmed.length > 1000 ? "..." : ""}`);

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
      handleCommandDirect(text);
      return;
    }

    messageQueue.push(text);
    if (!processing) {
      processQueue();
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
    chunkBuffer = "";
    chunksSent = 0;
    llm.send(text, promptFile);

    // Send "thinking" indicators
    const backendName = config.backend === "gemini" ? "Gemini" : "Claude";
    const thinkingTimer = setTimeout(async () => {
      if (llm.isAlive()) {
        try { await sessionClient.send("💭 thinking..."); } catch {}
      }
    }, 5_000);
    const stillThinkingTimer = setTimeout(async () => {
      if (llm.isAlive()) {
        try { await sessionClient.send("💭 still thinking..."); } catch {}
      }
    }, 90_000);

    // Periodically flush accumulated chunks with progressive intervals
    const startTime = Date.now();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleFlush() {
      const elapsed = Date.now() - startTime;
      const tier = FLUSH_SCHEDULE.find(t => elapsed < t.until) || FLUSH_SCHEDULE[FLUSH_SCHEDULE.length - 1];
      flushTimer = setTimeout(async () => {
        if (chunkBuffer.length > 0) {
          const toSend = chunkBuffer;
          chunkBuffer = "";
          chunksSent += toSend.length;
          console.log(`[proxy] Flushing ${toSend.length} chars of chunks to user (${chunksSent} total sent)`);
          try { await sessionClient.send(toSend); } catch {}
        }
        scheduleFlush();
      }, tier.interval);
    }
    scheduleFlush();

    // Wait for response
    const response = await llm.waitForResponse();
    clearTimeout(thinkingTimer);
    clearTimeout(stillThinkingTimer);
    if (flushTimer) clearTimeout(flushTimer);

    // Grab any remaining unflushed chunks
    const remainingChunks = chunkBuffer;
    chunkBuffer = "";

    // Empty response — tell the user (only if nothing was streamed)
    if (!response && chunksSent === 0 && !remainingChunks) {
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
        await sessionClient.send(`Avatar failed: ${msg}`);
      }
      return;
    }

    // Record the exchange in context (strip SVGs to save space)
    const fullResponse = response || remainingChunks || "";
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

    // Send response to user — only what hasn't been streamed already
    if (chunksSent === 0) {
      // Nothing was streamed — send full response, extracting any SVG images
      watchLog(`→ Sending response (${(response || "").length} chars)`);
      await sendRichResponse(response);
    } else if (remainingChunks.length > 0) {
      // Some was streamed, send the remaining buffer with SVG extraction
      watchLog(`→ Sending remaining ${remainingChunks.length} chars`);
      await sendRichResponse(remainingChunks);
    } else {
      watchLog(`→ Response fully streamed (${chunksSent} chars)`);
    }
    // If chunksSent > 0 and no remaining, everything was already delivered
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
