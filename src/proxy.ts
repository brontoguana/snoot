import type { Config } from "./types.js";
import { createSessionClient } from "./session.js";
import { createClaudeManager } from "./claude.js";
import { createContextStore } from "./context.js";
import { handleCommand } from "./commands.js";

export function createProxy(config: Config) {
  const context = createContextStore(config);
  const claude = createClaudeManager(config);
  let sessionClient: Awaited<ReturnType<typeof createSessionClient>>;
  let processing = false;
  let messageQueue: string[] = [];
  let shuttingDown = false;

  async function start(): Promise<void> {
    await context.load();
    sessionClient = await createSessionClient(config);

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

    // Check for /commands
    const cmdResult = handleCommand(text, config, context, claude);
    if (cmdResult) {
      // Handle /forget specially — reset context before sending response
      if (text.trim().toLowerCase() === "/forget") {
        if (claude.isAlive()) await claude.kill();
        await context.reset();
      } else {
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

    // Send "thinking" indicator if response takes more than 60s
    const thinkingTimer = setTimeout(async () => {
      if (claude.isAlive()) {
        try {
          await sessionClient.send("[Claude is still thinking...]");
        } catch {}
      }
    }, 60_000);

    // Wait for response
    const response = await claude.waitForResponse();
    clearTimeout(thinkingTimer);

    // Skip empty responses (e.g. idle timeout with no pending work)
    if (!response) return;

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
