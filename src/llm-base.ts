import type { Config, LLMManager, LLMStatus, Backend } from "./types.js";
import { TOOLS_BY_MODE } from "./types.js";

const RATE_LIMIT_RETRY_DELAY = 30_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const API_ERROR_RETRY_DELAYS = [30_000, 60_000];

/** Kill a process and all its descendants (children, grandchildren, etc.) */
function killProcessTree(pid: number): void {
  // Find children first, then kill bottom-up so parents don't respawn children
  try {
    const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
    const children = result.stdout.toString().trim().split("\n").filter(Boolean);
    for (const childPid of children) {
      killProcessTree(Number(childPid));
    }
  } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

export type OutputEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; detail: string; trackingDetail?: string }
  | { kind: "rate_limit"; reason?: string }
  | { kind: "result"; text: string }
  | { kind: "log"; message: string }
  | { kind: "model"; model: string };

export interface BackendHooks {
  label: string;
  backend: Backend;
  /** Spawn the LLM process. For Claude, this also writes to stdin. */
  spawn(config: Config, text: string, promptFile?: string): ReturnType<typeof Bun.spawn>;
  /** Parse a JSON line from stdout into normalized events. */
  parseOutput(json: any): OutputEvent[];
  /** Check if a result text indicates an API error worth retrying. */
  isApiError(text: string): boolean;
}

export function createBaseLLMManager(config: Config, hooks: BackendHooks): LLMManager {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let alive = false;
  const exitCallbacks: Array<() => void> = [];
  const chunkCallbacks: Array<(text: string) => void> = [];
  const rateLimitCallbacks: Array<(retryIn: number, attempt: number, reason?: string) => void> = [];
  const apiErrorCallbacks: Array<(retryIn: number, attempt: number, maxAttempts: number, reason?: string) => void> = [];
  const activityCallbacks: Array<(line: string) => void> = [];
  const toolUseCallbacks: Array<(detail: string) => void> = [];
  const modelCallbacks: Array<(model: string) => void> = [];
  let responseResolvers: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }> = [];
  let accumulatedText = "";
  let stdoutDone: Promise<void> = Promise.resolve();
  let spawnedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let rateLimitDetected = false;
  let rateLimitReason: string | undefined;
  let lastUserMessage = "";
  let lastPromptFile: string | undefined;
  let rateLimitRetryCount = 0;
  let apiErrorRetryCount = 0;
  let pendingRetry = false;
  let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  const spawnedPids = new Set<number>();
  const { label } = hooks;

  // -- Health check: detect OOM kills or unexpected process death --

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
        console.error(`[${label}] Health check: process ${proc.pid} is dead (likely OOM killed)`);
        emitActivity(`❌ Process died unexpectedly (pid ${proc.pid})`);

        alive = false;
        proc = null;
        stopHealthCheck();

        const pending = responseResolvers;
        responseResolvers = [];
        for (const { resolve } of pending) {
          resolve(accumulatedText || `[${label} process was killed unexpectedly (possibly OOM). Try again.]`);
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

  // -- Orphan checker: kill stale processes every 5s --

  const orphanCheckTimer = setInterval(() => {
    const currentPid = proc?.pid;
    for (const pid of spawnedPids) {
      if (pid === currentPid) continue;
      try {
        process.kill(pid, 0);
        console.error(`[${label}] ORPHAN DETECTED: pid ${pid} still alive (current: ${currentPid ?? "none"}) — killing`);
        killProcessTree(pid);
        spawnedPids.delete(pid);
      } catch {
        spawnedPids.delete(pid);
      }
    }
  }, 5_000);
  if (orphanCheckTimer.unref) orphanCheckTimer.unref();

  // -- Helpers --

  function emitActivity(line: string): void {
    for (const cb of activityCallbacks) cb(line);
  }

  // -- Process lifecycle --

  function spawnProcess(text: string, promptFile?: string): void {
    try {
      proc = hooks.spawn(config, text, promptFile);
    } catch (err) {
      console.error(`[${label}] Failed to spawn process:`, err);
      const pending = responseResolvers;
      responseResolvers = [];
      for (const { resolve } of pending) {
        resolve(`[Failed to start ${label}: ${err instanceof Error ? err.message : err}]`);
      }
      return;
    }

    alive = true;
    accumulatedText = "";
    spawnedAt = Date.now();
    lastActivityAt = Date.now();
    spawnedPids.add(proc.pid);
    startHealthCheck();

    console.log(`[${label}] Spawned process (pid: ${proc.pid})`);
    emitActivity(`⚡ ${label} spawned (pid ${proc.pid})`);

    // Read stdout as NDJSON — keep promise so exit handler can wait for it
    stdoutDone = readOutputStream();

    // Read stderr for logging
    readErrorStream();

    // Handle process exit — wait for stdout to drain before resolving
    const thisProc = proc;
    proc.exited.then(async (code) => {
      await stdoutDone;

      // If a newer process has been spawned, this exit is stale — ignore it.
      if (proc !== thisProc) {
        console.log(`[${label}] Stale exit ignored (pid was ${thisProc.pid})`);
        return;
      }

      alive = false;
      stopHealthCheck();

      if (code !== 0) {
        console.error(`[${label}] Process exited with code ${code}`);
        emitActivity(`❌ Process exited with code ${code}`);
      } else {
        console.log(`[${label}] Process exited normally`);
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
          resolve(accumulatedText);
        } else if (code !== 0) {
          resolve(`[${label} process failed (exit code ${code})]`);
        } else {
          resolve("");
        }
      }
      accumulatedText = "";

      for (const cb of exitCallbacks) cb();
    });
  }

  // -- Stream readers --

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
            const json = JSON.parse(line);
            handleOutputMessage(json);
          } catch {
            console.log(`[${label}:stdout] ${line}`);
          }
        }
      }
    } catch (err) {
      if (alive) {
        console.error(`[${label}] Error reading stdout:`, err);
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
            console.error(`[${label}:stderr] ${line}`);
          }
        }
      }
    } catch {
      // stderr closed, expected on process exit
    }
  }

  // -- Output handling --

  function handleOutputMessage(json: any): void {
    lastActivityAt = Date.now();
    console.log(`[${label}] Output message type: ${json.type}`);

    const events = hooks.parseOutput(json);
    for (const event of events) {
      switch (event.kind) {
        case "text":
          accumulatedText += event.text;
          console.log(`[${label}] Accumulated text: ${accumulatedText.slice(0, 100)}...`);
          for (const cb of chunkCallbacks) cb(event.text);
          break;
        case "tool_use": {
          // Enforce tool restrictions for non-coding modes (research/chat)
          const toolName = event.detail.split(/[\s:]/)[0]; // e.g. "Bash" from "Bash: npm run build"
          const allowedTools = config.mode !== "coding" ? TOOLS_BY_MODE[config.mode] : null;
          if (allowedTools !== null && toolName && !allowedTools.split(",").includes(toolName)) {
            console.log(`[${label}] BLOCKED tool "${toolName}" — not allowed in ${config.mode} mode`);
            emitActivity(`🚫 Blocked ${toolName} (read-only mode)`);
            // Kill the entire process tree immediately — the tool may already be running
            if (proc) {
              const pid = proc.pid;
              alive = false;
              stopHealthCheck();
              killProcessTree(pid);
              proc = null;
              // Resolve pending resolvers so the proxy doesn't hang
              const pending = responseResolvers;
              responseResolvers = [];
              for (const { resolve } of pending) {
                resolve(accumulatedText || `[Stopped — ${toolName} is not allowed in ${config.mode} mode]`);
              }
              accumulatedText = "";
              for (const cb of exitCallbacks) cb();
            }
            break;
          }
          console.log(`[${label}] Tool use: ${event.detail}`);
          emitActivity(`🔧 ${event.detail}`);
          for (const cb of toolUseCallbacks) cb(event.trackingDetail ?? event.detail);
          break;
        }
        case "rate_limit":
          rateLimitDetected = true;
          rateLimitReason = event.reason;
          break;
        case "log":
          console.log(`[${label}] ${event.message}`);
          break;
        case "model":
          for (const cb of modelCallbacks) cb(event.model);
          break;
        case "result":
          handleResult(event.text);
          break;
      }
    }
  }

  function handleResult(resultText: string): void {
    // Use the result text if available, otherwise use accumulated text
    const responseText = resultText || accumulatedText;
    accumulatedText = "";

    // Rate limit retry: empty result + rate limit detected + retries left
    if (!responseText && rateLimitDetected && rateLimitRetryCount < MAX_RATE_LIMIT_RETRIES && lastUserMessage) {
      rateLimitRetryCount++;
      const reason = rateLimitReason;
      rateLimitDetected = false;
      rateLimitReason = undefined;
      pendingRetry = true;
      console.log(`[${label}] Rate limited — retrying in ${RATE_LIMIT_RETRY_DELAY / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})${reason ? ` [${reason}]` : ""}`);

      for (const cb of rateLimitCallbacks) {
        cb(RATE_LIMIT_RETRY_DELAY / 1000, rateLimitRetryCount, reason);
      }

      pendingRetryTimer = setTimeout(() => {
        pendingRetry = false;
        pendingRetryTimer = null;
        forceKill();
        console.log(`[${label}] Resending after rate limit (attempt ${rateLimitRetryCount}) — spawning new process`);
        spawnProcess(lastUserMessage, lastPromptFile);
      }, RATE_LIMIT_RETRY_DELAY);
      return;
    }

    // API error retry
    if (hooks.isApiError(responseText) && lastUserMessage && apiErrorRetryCount < API_ERROR_RETRY_DELAYS.length) {
      const delay = API_ERROR_RETRY_DELAYS[apiErrorRetryCount];
      apiErrorRetryCount++;
      pendingRetry = true;
      console.log(`[${label}] API error — retrying in ${delay / 1000}s (attempt ${apiErrorRetryCount}/${API_ERROR_RETRY_DELAYS.length})`);

      for (const cb of apiErrorCallbacks) {
        cb(delay / 1000, apiErrorRetryCount, API_ERROR_RETRY_DELAYS.length, responseText);
      }

      pendingRetryTimer = setTimeout(() => {
        pendingRetry = false;
        pendingRetryTimer = null;
        forceKill();
        console.log(`[${label}] Resending after API error (attempt ${apiErrorRetryCount}) — spawning new process`);
        spawnProcess(lastUserMessage, lastPromptFile);
      }, delay);
      return;
    }

    // API error with retries exhausted — give up with clean message
    if (hooks.isApiError(responseText)) {
      console.log(`[${label}] API error — retries exhausted, giving up`);
      apiErrorRetryCount = 0;
      const resolver = responseResolvers.shift();
      if (resolver) resolver.resolve("[API error — retried but still failing. Try /model to switch models or try again later.]");
      return;
    }

    // If we got text but also hit a rate limit, the response is likely truncated
    let finalText = responseText;
    if (responseText && rateLimitDetected) {
      const reason = rateLimitReason || "rate limit";
      console.log(`[${label}] Response truncated by ${reason} (${responseText.length} chars received)`);
      finalText += `\n\n⚠️ Response may be incomplete — hit ${reason}. Send /model to switch models or resend your message to continue.`;
    }

    rateLimitDetected = false;
    rateLimitReason = undefined;
    rateLimitRetryCount = 0;
    apiErrorRetryCount = 0;

    console.log(`[${label}] Result received (${finalText.length} chars), resolvers waiting: ${responseResolvers.length}`);
    emitActivity(`✅ Done (${finalText.length} chars)`);
    const resolver = responseResolvers.shift();
    if (resolver) {
      resolver.resolve(finalText);
    }
  }

  // -- Public API --

  function isAlive(): boolean {
    return alive;
  }

  function isPendingRetry(): boolean {
    return pendingRetry;
  }

  function cancelRetry(): void {
    if (!pendingRetry) return;
    if (pendingRetryTimer) {
      clearTimeout(pendingRetryTimer);
      pendingRetryTimer = null;
    }
    pendingRetry = false;
    rateLimitRetryCount = 0;
    apiErrorRetryCount = 0;
    console.log(`[${label}] Retry cancelled`);

    const pending = responseResolvers;
    responseResolvers = [];
    for (const { resolve } of pending) {
      resolve("");
    }
    accumulatedText = "";

    for (const cb of exitCallbacks) cb();
  }

  /** Synchronous SIGKILL — for use in SIGTERM/SIGINT handlers */
  function forceKill(): void {
    if (!proc) return;
    const pid = proc.pid;
    alive = false;
    stopHealthCheck();
    killProcessTree(pid);
    proc = null;

    // Resolve pending resolvers so waitForResponse() callers don't hang
    const pending = responseResolvers;
    responseResolvers = [];
    for (const { resolve } of pending) {
      resolve(accumulatedText || "");
    }
    accumulatedText = "";
  }

  function send(text: string, promptFile?: string): void {
    lastUserMessage = text;
    lastPromptFile = promptFile;
    rateLimitRetryCount = 0;
    apiErrorRetryCount = 0;

    // Queue should prevent concurrent sends, but watchdog timeout can bypass it
    if (proc && alive) {
      console.error(`[${label}] WARNING: send() called with running process — killing old one`);
      forceKill();
    }

    spawnProcess(text, promptFile);
  }

  function waitForResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      responseResolvers.push({ resolve, reject });
    });
  }

  async function kill(): Promise<void> {
    if (!proc || !alive) return;

    const pid = proc.pid;
    alive = false;
    stopHealthCheck();

    try {
      // Close stdin to let the process finish gracefully
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
        // SIGTERM the main process
        proc.kill("SIGTERM");
        const termed = await Promise.race([
          proc.exited,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);

        if (termed === null) {
          // SIGKILL the entire process tree (main + children like bash builds)
          killProcessTree(pid);
        }
      }
    } catch {
      // Process already dead — still kill the tree in case children survived
      killProcessTree(pid);
    }

    proc = null;

    // Resolve pending response resolvers immediately — the exit handler will
    // see this as a "stale exit" (proc !== thisProc) and skip them, so we
    // must resolve here to unblock waitForResponse() callers (e.g. /stop).
    const pending = responseResolvers;
    responseResolvers = [];
    for (const { resolve } of pending) {
      resolve(accumulatedText || "");
    }
    accumulatedText = "";

    for (const cb of exitCallbacks) cb();
  }

  function onExit(cb: () => void): void {
    exitCallbacks.push(cb);
  }

  function onChunk(cb: (text: string) => void): void {
    chunkCallbacks.push(cb);
  }

  function onRateLimit(cb: (retryIn: number, attempt: number, reason?: string) => void): void {
    rateLimitCallbacks.push(cb);
  }

  function onApiError(cb: (retryIn: number, attempt: number, maxAttempts: number, reason?: string) => void): void {
    apiErrorCallbacks.push(cb);
  }

  function onActivity(cb: (line: string) => void): void {
    activityCallbacks.push(cb);
  }

  function onToolUse(cb: (detail: string) => void): void {
    toolUseCallbacks.push(cb);
  }

  function onModel(cb: (model: string) => void): void {
    modelCallbacks.push(cb);
  }

  function getStatus(): LLMStatus {
    return {
      alive,
      busy: responseResolvers.length > 0,
      spawnedAt,
      lastActivityAt,
      backend: hooks.backend,
    };
  }

  return { isAlive, isPendingRetry, cancelRetry, send, waitForResponse, kill, forceKill, onExit, onChunk, onRateLimit, onApiError, onActivity, onToolUse, onModel, getStatus };
}
