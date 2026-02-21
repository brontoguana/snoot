import { join } from "path";
import { existsSync } from "fs";
import type { Config } from "./types.js";
import { createSessionClient } from "./session.js";
import { createClaudeManager } from "./claude.js";
import { createContextStore } from "./context.js";
import { handleCommand } from "./commands.js";
import { buildProfilePrompt, convertAvatarSvg } from "./profile.js";

export function createProxy(config: Config) {
  const context = createContextStore(config);
  const claude = createClaudeManager(config);
  let sessionClient: Awaited<ReturnType<typeof createSessionClient>>;
  let processing = false;
  let messageQueue: string[] = [];
  let shuttingDown = false;
  let pendingAvatar = false;

  const avatarSvgPath = join(config.baseDir, "avatar.svg");

  async function start(): Promise<void> {
    await context.load();
    sessionClient = await createSessionClient(config);

    // Wire up rate limit notification
    claude.onRateLimit(async (retryIn, attempt) => {
      try {
        await sessionClient.send(`⏳ Rate limited — retrying in ${retryIn}s (attempt ${attempt}/5)`);
      } catch {}
    });

    // Wire up process exit handler
    claude.onExit(async () => {
      if (shuttingDown) return;

      // Check if compaction is needed between bursts
      if (context.needsCompaction()) {
        console.log("[proxy] Compaction threshold reached, compacting...");
        await context.compact();
      }
    });

    sessionClient.startListening(onMessage);
    console.log(`[proxy] Ready. Mode: ${config.mode}`);

    // Greet the user so the conversation appears in their Session app
    await sessionClient.send(
      `Snoot is online. Mode: ${config.mode}. Working dir: ${config.workDir}\nSend /help for commands.`
    );
  }

  function onMessage(text: string): void {
    // /hi and /update bypass the queue so they respond even while Claude is busy
    const trimmed = text.trim().toLowerCase();
    if (trimmed === "/hi" || trimmed === "/update") {
      const cmdResult = handleCommand(text, config, context, claude);
      if (cmdResult) {
        sessionClient.send(cmdResult.response).catch(() => {});
      }
      return;
    }

    messageQueue.push(text);
    if (!processing) {
      processQueue();
    }
  }

  async function processQueue(): Promise<void> {
    processing = true;

    while (messageQueue.length > 0) {
      const text = messageQueue.shift()!;
      try {
        await handleMessage(text);
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
    const cmdResult = handleCommand(text, config, context, claude);
    if (cmdResult) {
      // Handle /forget and /clear specially — reset context before sending response
      const cmd = text.trim().toLowerCase();
      if (cmd === "/forget" || cmd === "/clear") {
        if (claude.isAlive()) await claude.kill();
        await context.reset();
      } else {
        if (cmdResult.restartProcess) {
          if (claude.isAlive()) await claude.kill();
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
        if (cmdResult.killProcess && claude.isAlive()) {
          await claude.kill();
        }
        if (cmdResult.triggerCompaction) {
          await context.compact();
        }
      }

      await sessionClient.send(cmdResult.response);
      return;
    }

    // Regular message — send to Claude
    if (claude.isAlive()) {
      // Mid-burst injection: pipe directly to existing process
      claude.send(text);
    } else {
      // New burst: build context prompt file, spawn fresh process
      const promptFile = context.buildPrompt();
      claude.send(text, promptFile);
    }

    // Send "thinking" indicators at 10s and 90s
    const thinkingTimer = setTimeout(async () => {
      if (claude.isAlive()) {
        try { await sessionClient.send("💭 thinking..."); } catch {}
      }
    }, 5_000);
    const stillThinkingTimer = setTimeout(async () => {
      if (claude.isAlive()) {
        try { await sessionClient.send("💭 still thinking..."); } catch {}
      }
    }, 90_000);

    // Wait for response
    const response = await claude.waitForResponse();
    clearTimeout(thinkingTimer);
    clearTimeout(stillThinkingTimer);

    // Empty response — tell the user instead of silently dropping
    if (!response) {
      console.log("[proxy] Claude returned empty response");
      await sessionClient.send("Claude returned an empty response — it may have hit a limit. Try again or /kill to reset.");
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

    // Record the exchange
    const pair = {
      id: context.nextPairId(),
      user: text,
      assistant: response,
      timestamp: Date.now(),
    };
    await context.append(pair);

    // Send response to user via Session
    await sessionClient.send(response);
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    console.log("\n[proxy] Shutting down...");

    if (claude.isAlive()) {
      await claude.kill();
    }

    console.log("[proxy] Goodbye.");
    process.exit(0);
  }

  return { start, shutdown };
}
