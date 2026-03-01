import type { Config, LLMManager, LLMStatus } from "./types.js";
import { readFileSync } from "fs";

const RATE_LIMIT_RETRY_DELAY = 30_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const API_ERROR_RETRY_DELAYS = [30_000, 60_000];

/** Gemini stream-json event types */
interface GeminiStreamEvent {
  type: "init" | "message" | "tool_use" | "tool_result" | "error" | "result";
  timestamp?: string;
  [key: string]: unknown;
}

export function createGeminiManager(config: Config): LLMManager {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let alive = false;
  let exitCallbacks: Array<() => void> = [];
  let chunkCallbacks: Array<(text: string) => void> = [];
  let rateLimitCallbacks: Array<(retryIn: number, attempt: number) => void> = [];
  let apiErrorCallbacks: Array<(retryIn: number, attempt: number, maxAttempts: number) => void> = [];
  let activityCallbacks: Array<(line: string) => void> = [];
  let responseResolvers: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }> = [];
  let accumulatedText = "";
  let spawnedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let lastUserMessage = "";
  let lastPromptFile: string | undefined;
  let rateLimitRetryCount = 0;
  let apiErrorRetryCount = 0;
  let pendingRetry = false;
  let rateLimitDetected = false;
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  function startHealthCheck(): void {
    stopHealthCheck();
    healthCheckTimer = setInterval(() => {
      if (!proc || !alive) {
        stopHealthCheck();
        return;
      }

      try {
        process.kill(proc.pid, 0);
      } catch {
        console.error(`[gemini] Health check: process ${proc.pid} is dead (likely OOM killed)`);
        emitActivity(`❌ Process died unexpectedly (pid ${proc.pid})`);

        alive = false;
        proc = null;
        stopHealthCheck();

        const pending = responseResolvers;
        responseResolvers = [];
        for (const { resolve } of pending) {
          if (accumulatedText) {
            resolve(accumulatedText);
          } else {
            resolve("[Gemini process was killed unexpectedly (possibly OOM). Try again.]");
          }
        }
        accumulatedText = "";

        for (const cb of exitCallbacks) cb();
      }
    }, 20_000);
  }

  function stopHealthCheck(): void {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
  }

  function emitActivity(line: string): void {
    for (const cb of activityCallbacks) cb(line);
  }

  function buildArgs(): string[] {
    const args = [
      "gemini",
      "-p", "", // placeholder, actual prompt goes to stdin
      "-o", "stream-json",
      "--yolo",
    ];
    return args;
  }

  function spawnProcess(fullPrompt: string): void {
    const args = [
      "gemini",
      "-o", "stream-json",
      "--yolo",
      "-p", fullPrompt,
    ];

    const env = { ...process.env };

    proc = Bun.spawn(args, {
      cwd: config.workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    alive = true;
    accumulatedText = "";
    spawnedAt = Date.now();
    lastActivityAt = Date.now();
    startHealthCheck();

    console.log(`[gemini] Spawned process (pid: ${proc.pid})`);
    emitActivity(`⚡ gemini spawned (pid ${proc.pid})`);

    readOutputStream();
    readErrorStream();

    proc.exited.then((code) => {
      alive = false;
      stopHealthCheck();

      if (code !== 0) {
        console.error(`[gemini] Process exited with code ${code}`);
        emitActivity(`❌ Process exited with code ${code}`);
      } else {
        console.log("[gemini] Process exited normally");
      }

      if (pendingRetry) {
        accumulatedText = "";
        for (const cb of exitCallbacks) cb();
        return;
      }

      const pending = responseResolvers;
      responseResolvers = [];
      for (const { resolve } of pending) {
        if (accumulatedText) {
          resolve(accumulatedText);
        } else if (code !== 0) {
          resolve(`[Gemini process failed (exit code ${code})]`);
        } else {
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
            const msg: GeminiStreamEvent = JSON.parse(line);
            handleOutputMessage(msg);
          } catch {
            console.log(`[gemini:stdout] ${line}`);
          }
        }
      }
    } catch (err) {
      if (alive) {
        console.error("[gemini] Error reading stdout:", err);
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
            console.error(`[gemini:stderr] ${line}`);
          }
        }
      }
    } catch {
      // stderr closed
    }
  }

  function handleOutputMessage(msg: GeminiStreamEvent): void {
    lastActivityAt = Date.now();
    console.log(`[gemini] Output message type: ${msg.type}`);

    switch (msg.type) {
      case "message": {
        // Gemini sends message events with role and content
        const role = msg.role as string;
        const content = msg.content as string;
        if (role === "assistant" && content) {
          accumulatedText += content;
          console.log(`[gemini] Accumulated text: ${accumulatedText.slice(0, 100)}...`);
          for (const cb of chunkCallbacks) cb(content);
        }
        break;
      }
      case "error": {
        const message = (msg.message as string) || "";
        const severity = (msg.severity as string) || "error";
        console.error(`[gemini] Error (${severity}): ${message}`);

        // Check for rate limiting
        const lower = message.toLowerCase();
        if (lower.includes("rate") || lower.includes("limit") || lower.includes("quota") || lower.includes("429")) {
          rateLimitDetected = true;
        }
        break;
      }
      case "result": {
        const responseText = accumulatedText;
        accumulatedText = "";

        // Rate limit retry
        if (!responseText && rateLimitDetected && rateLimitRetryCount < MAX_RATE_LIMIT_RETRIES && lastUserMessage) {
          rateLimitRetryCount++;
          rateLimitDetected = false;
          pendingRetry = true;
          console.log(`[gemini] Rate limited — retrying in ${RATE_LIMIT_RETRY_DELAY / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})`);

          for (const cb of rateLimitCallbacks) {
            cb(RATE_LIMIT_RETRY_DELAY / 1000, rateLimitRetryCount);
          }

          setTimeout(() => {
            pendingRetry = false;
            console.log(`[gemini] Resending after rate limit (attempt ${rateLimitRetryCount})`);
            spawnProcess(lastUserMessage);
          }, RATE_LIMIT_RETRY_DELAY);
          break;
        }

        // API error retry
        const isApiError = responseText.includes("500") ||
                           responseText.includes("Internal server error") ||
                           responseText.includes("INTERNAL");

        if (isApiError && !responseText.trim() && lastUserMessage && apiErrorRetryCount < API_ERROR_RETRY_DELAYS.length) {
          const delay = API_ERROR_RETRY_DELAYS[apiErrorRetryCount];
          apiErrorRetryCount++;
          pendingRetry = true;
          console.log(`[gemini] API error — retrying in ${delay / 1000}s (attempt ${apiErrorRetryCount}/${API_ERROR_RETRY_DELAYS.length})`);

          for (const cb of apiErrorCallbacks) {
            cb(delay / 1000, apiErrorRetryCount, API_ERROR_RETRY_DELAYS.length);
          }

          setTimeout(() => {
            pendingRetry = false;
            console.log(`[gemini] Resending after API error (attempt ${apiErrorRetryCount})`);
            spawnProcess(lastUserMessage);
          }, delay);
          break;
        }

        rateLimitDetected = false;
        rateLimitRetryCount = 0;
        apiErrorRetryCount = 0;

        console.log(`[gemini] Result received (${responseText.length} chars), resolvers waiting: ${responseResolvers.length}`);
        emitActivity(`✅ Done (${responseText.length} chars)`);
        const resolver = responseResolvers.shift();
        if (resolver) {
          resolver.resolve(responseText);
        }
        break;
      }
      case "init":
        console.log(`[gemini] Session initialized: model=${msg.model}`);
        break;
      case "tool_use":
        console.log(`[gemini] Tool use: ${msg.tool_name}`);
        emitActivity(`🔧 ${msg.tool_name || "unknown tool"}`);
        break;
      case "tool_result":
        console.log(`[gemini] Tool result: ${msg.tool_id} (${msg.status})`);
        break;
      default:
        break;
    }
  }

  function isAlive(): boolean {
    return alive;
  }

  function send(text: string, promptFile?: string): void {
    rateLimitRetryCount = 0;
    apiErrorRetryCount = 0;

    // Kill any leftover process
    if (proc && alive) {
      try { proc.kill("SIGKILL"); } catch {}
      proc = null;
      alive = false;
    }

    // Build the full prompt: system prompt from file + user message
    let fullPrompt = text;
    if (promptFile) {
      try {
        const systemPrompt = readFileSync(promptFile, "utf-8");
        fullPrompt = systemPrompt + "\n\n" + text;
      } catch (err) {
        console.error("[gemini] Error reading prompt file:", err);
      }
    }

    lastUserMessage = fullPrompt;
    lastPromptFile = promptFile;

    spawnProcess(fullPrompt);
  }

  function waitForResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      responseResolvers.push({ resolve, reject });
    });
  }

  async function kill(): Promise<void> {
    if (!proc || !alive) return;

    alive = false;
    stopHealthCheck();

    try {
      proc.kill("SIGTERM");
      const termed = await Promise.race([
        proc.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);

      if (termed === null) {
        proc.kill("SIGKILL");
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

  function onActivity(cb: (line: string) => void): void {
    activityCallbacks.push(cb);
  }

  function getStatus(): LLMStatus {
    return {
      alive,
      busy: responseResolvers.length > 0,
      spawnedAt,
      lastActivityAt,
      backend: "gemini",
    };
  }

  return { isAlive, send, waitForResponse, kill, onExit, onChunk, onRateLimit, onApiError, onActivity, getStatus };
}
