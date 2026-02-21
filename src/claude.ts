import type { Config, LLMManager, LLMStatus, StreamJsonOutput } from "./types.js";
import { TOOLS_BY_MODE } from "./types.js";

const RATE_LIMIT_RETRY_DELAY = 30_000; // 30 seconds
const MAX_RATE_LIMIT_RETRIES = 5;
const API_ERROR_RETRY_DELAYS = [30_000, 60_000]; // 30s, then 60s, then give up

export function createClaudeManager(config: Config): LLMManager {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let alive = false;
  let exitCallbacks: Array<() => void> = [];
  let chunkCallbacks: Array<(text: string) => void> = [];
  let rateLimitCallbacks: Array<(retryIn: number, attempt: number) => void> = [];
  let apiErrorCallbacks: Array<(retryIn: number, attempt: number, maxAttempts: number) => void> = [];
  // Response queue: resolvers waiting for result messages
  let responseResolvers: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }> = [];
  let accumulatedText = "";
  let spawnedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let rateLimitDetected = false;
  let lastUserMessage = "";
  let lastPromptFile: string | undefined;
  let rateLimitRetryCount = 0;
  let apiErrorRetryCount = 0;
  let pendingRetry = false;

  function spawnProcess(promptFile?: string): void {
    const tools = TOOLS_BY_MODE[config.mode];
    const args = [
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
    ];

    if (config.budgetUsd !== undefined) {
      args.push("--max-budget-usd", config.budgetUsd.toString());
    }

    if (promptFile) {
      args.push("--append-system-prompt-file", promptFile);
    }

    if (tools) {
      args.push("--tools", tools);
    } else {
      // chat mode: no tools
      args.push("--tools", "");
    }

    const env = { ...process.env };
    delete env.CLAUDECODE; // prevent nested session detection

    try {
      proc = Bun.spawn(args, {
        cwd: config.workDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
    } catch (err) {
      console.error("[claude] Failed to spawn process:", err);
      const pending = responseResolvers;
      responseResolvers = [];
      for (const { resolve } of pending) {
        resolve(`[Failed to start Claude: ${err instanceof Error ? err.message : err}]`);
      }
      return;
    }

    alive = true;
    accumulatedText = "";
    spawnedAt = Date.now();
    lastActivityAt = Date.now();

    console.log(`[claude] Spawned process (pid: ${proc.pid})`);
    console.log(`[claude] Args: ${args.join(" ")}`);

    // Read stdout as NDJSON
    readOutputStream();

    // Read stderr for logging
    readErrorStream();

    // Handle process exit
    proc.exited.then((code) => {
      alive = false;

      if (code !== 0) {
        console.error(`[claude] Process exited with code ${code}`);
      } else {
        console.log("[claude] Process exited normally");
      }

      // If we're waiting for a rate limit retry, don't resolve pending resolvers
      if (pendingRetry) {
        accumulatedText = "";
        for (const cb of exitCallbacks) cb();
        return;
      }

      // Resolve any pending response resolvers
      const pending = responseResolvers;
      responseResolvers = [];
      for (const { resolve } of pending) {
        if (accumulatedText) {
          // Partial response — send what we got
          resolve(accumulatedText);
        } else if (code !== 0) {
          resolve(`[Claude process failed (exit code ${code})]`);
        } else {
          // Process exited cleanly but no response — empty result
          resolve("");
        }
      }
      accumulatedText = "";

      for (const cb of exitCallbacks) cb();
    });
  }

  async function readOutputStream(): Promise<void> {
    const stdout = proc?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;


          try {
            const msg: StreamJsonOutput = JSON.parse(line);
            handleOutputMessage(msg);
          } catch {
            // Non-JSON line, log and ignore
            console.log(`[claude:stdout] ${line}`);
          }
        }
      }
    } catch (err) {
      if (alive) {
        console.error("[claude] Error reading stdout:", err);
      }
    }
  }

  async function readErrorStream(): Promise<void> {
    const stderr = proc?.stderr;
    if (!stderr || typeof stderr === "number") return;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim()) {
            console.error(`[claude:stderr] ${line}`);
          }
        }
      }
    } catch {
      // stderr closed, expected on process exit
    }
  }

  function handleOutputMessage(msg: StreamJsonOutput): void {
    lastActivityAt = Date.now();
    console.log(`[claude] Output message type: ${msg.type}`);
    switch (msg.type) {
      case "assistant": {
        // Complete assistant message — extract text content
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              accumulatedText += block.text;
              console.log(`[claude] Accumulated text: ${accumulatedText.slice(0, 100)}...`);
              for (const cb of chunkCallbacks) cb(block.text);
            }
          }
        }
        break;
      }
      case "system": {
        // Check for rate limit indicators
        const raw = JSON.stringify(msg).toLowerCase();
        if (raw.includes("rate") || raw.includes("limit") || raw.includes("throttl") || raw.includes("429") || raw.includes("overloaded")) {
          rateLimitDetected = true;
          console.log(`[claude] Rate limit detected: ${JSON.stringify(msg).slice(0, 200)}`);
        } else {
          console.log(`[claude] System message: ${JSON.stringify(msg).slice(0, 200)}`);
        }
        break;
      }
      case "rate_limit_event": {
        rateLimitDetected = true;
        console.log(`[claude] Rate limit event: ${JSON.stringify(msg).slice(0, 300)}`);
        break;
      }
      case "result": {
        // Response complete — resolve the oldest waiting promise
        const result = (msg as any).result as string;
        // Use the result text if available, otherwise use accumulated text
        const responseText = result || accumulatedText;
        accumulatedText = "";

        // Rate limit retry: empty result + rate limit detected + retries left
        if (!responseText && rateLimitDetected && rateLimitRetryCount < MAX_RATE_LIMIT_RETRIES && lastUserMessage) {
          rateLimitRetryCount++;
          rateLimitDetected = false;
          pendingRetry = true;
          console.log(`[claude] Rate limited — retrying in ${RATE_LIMIT_RETRY_DELAY / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})`);

          // Notify proxy so it can tell the user
          for (const cb of rateLimitCallbacks) {
            cb(RATE_LIMIT_RETRY_DELAY / 1000, rateLimitRetryCount);
          }

          setTimeout(() => {
            pendingRetry = false;

            // Spawn a fresh process for the retry
            console.log(`[claude] Resending after rate limit (attempt ${rateLimitRetryCount}) — spawning new process`);
            spawnProcess(lastPromptFile);
            try {
              const stdin = proc!.stdin as import("bun").FileSink;
              stdin.write(lastUserMessage);
              stdin.end();
            } catch (err) {
              console.error("[claude] Error resending after rate limit:", err);
              const resolver = responseResolvers.shift();
              if (resolver) resolver.resolve("[Rate limited — retry failed]");
            }
          }, RATE_LIMIT_RETRY_DELAY);
          break;
        }

        // API 500 error retry
        const isApiError = responseText.includes("API Error: 500") ||
                           responseText.includes('"type":"api_error"') ||
                           responseText.includes("Internal server error");

        if (isApiError && lastUserMessage && apiErrorRetryCount < API_ERROR_RETRY_DELAYS.length) {
          const delay = API_ERROR_RETRY_DELAYS[apiErrorRetryCount];
          apiErrorRetryCount++;
          pendingRetry = true;
          console.log(`[claude] API 500 error — retrying in ${delay / 1000}s (attempt ${apiErrorRetryCount}/${API_ERROR_RETRY_DELAYS.length})`);

          for (const cb of apiErrorCallbacks) {
            cb(delay / 1000, apiErrorRetryCount, API_ERROR_RETRY_DELAYS.length);
          }

          setTimeout(() => {
            pendingRetry = false;

            console.log(`[claude] Resending after API error (attempt ${apiErrorRetryCount}) — spawning new process`);
            spawnProcess(lastPromptFile);
            try {
              const stdin = proc!.stdin as import("bun").FileSink;
              stdin.write(lastUserMessage);
              stdin.end();
            } catch (err) {
              console.error("[claude] Error resending after API error:", err);
              const resolver = responseResolvers.shift();
              if (resolver) resolver.resolve("[API error — retry failed]");
            }
          }, delay);
          break;
        }

        // API error with retries exhausted — give up with clean message
        if (isApiError) {
          console.log(`[claude] API 500 error — retries exhausted, giving up`);
          apiErrorRetryCount = 0;
          const resolver = responseResolvers.shift();
          if (resolver) resolver.resolve("[API error (500) — retried but still failing. Try again later.]");
          break;
        }

        rateLimitDetected = false;
        rateLimitRetryCount = 0;
        apiErrorRetryCount = 0;

        console.log(`[claude] Result received (${responseText.length} chars), resolvers waiting: ${responseResolvers.length}`);
        const resolver = responseResolvers.shift();
        if (resolver) {
          resolver.resolve(responseText);
        }
        break;
      }
      default:
        // stream_event, etc. — ignore
        break;
    }
  }

  function isAlive(): boolean {
    return alive;
  }

  function send(text: string, promptFile?: string): void {
    lastUserMessage = text;
    lastPromptFile = promptFile;
    rateLimitRetryCount = 0;
    apiErrorRetryCount = 0;

    // Kill any leftover process (shouldn't exist, but safety)
    if (proc && alive) {
      try { proc.kill("SIGKILL"); } catch {}
      proc = null;
      alive = false;
    }

    // Spawn fresh process
    spawnProcess(promptFile);

    // Write prompt as plain text to stdin, then close
    try {
      const stdin = proc!.stdin as import("bun").FileSink;
      stdin.write(text);
      stdin.end();
    } catch (err) {
      console.error("[claude] Error writing to stdin:", err);
    }
  }

  function waitForResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      responseResolvers.push({ resolve, reject });
    });
  }

  async function kill(): Promise<void> {
    if (!proc || !alive) return;

    alive = false;

    try {
      // Close stdin to let Claude finish gracefully
      const stdin = proc.stdin;
      if (stdin && typeof stdin !== "number") {
        (stdin as import("bun").FileSink).end();
      }

      // Wait up to 5 seconds for graceful exit
      const graceful = await Promise.race([
        proc.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);

      if (graceful === null) {
        // SIGTERM
        proc.kill("SIGTERM");
        const termed = await Promise.race([
          proc.exited,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);

        if (termed === null) {
          // SIGKILL
          proc.kill("SIGKILL");
        }
      }
    } catch {
      // Process already dead
    }

    proc = null;
  }

  function onExit(cb: () => void): void {
    exitCallbacks.push(cb);
  }

  function onChunk(cb: (text: string) => void): void {
    chunkCallbacks.push(cb);
  }

  function onRateLimit(cb: (retryIn: number, attempt: number) => void): void {
    rateLimitCallbacks.push(cb);
  }

  function onApiError(cb: (retryIn: number, attempt: number, maxAttempts: number) => void): void {
    apiErrorCallbacks.push(cb);
  }

  function getStatus(): LLMStatus {
    return {
      alive,
      busy: responseResolvers.length > 0,
      spawnedAt,
      lastActivityAt,
      backend: "claude",
    };
  }

  return { isAlive, send, waitForResponse, kill, onExit, onChunk, onRateLimit, onApiError, getStatus };
}
