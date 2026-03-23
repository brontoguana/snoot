import type { Config, LLMManager, LLMStatus, Backend } from "./types.js";

const RATE_LIMIT_RETRY_DELAY = 30_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const API_ERROR_RETRY_DELAYS = [30_000, 60_000];

export type OutputEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; detail: string }
  | { kind: "rate_limit" }
  | { kind: "result"; text: string }
  | { kind: "log"; message: string };

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
  const rateLimitCallbacks: Array<(retryIn: number, attempt: number) => void> = [];
  const apiErrorCallbacks: Array<(retryIn: number, attempt: number, maxAttempts: number) => void> = [];
  const activityCallbacks: Array<(line: string) => void> = [];
  const toolUseCallbacks: Array<(detail: string) => void> = [];
  let responseResolvers: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }> = [];
  let accumulatedText = "";
  let stdoutDone: Promise<void> = Promise.resolve();
  let spawnedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let rateLimitDetected = false;
  let lastUserMessage = "";
  let lastPromptFile: string | undefined;
  let rateLimitRetryCount = 0;
  let apiErrorRetryCount = 0;
  let pendingRetry = false;
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
        try { process.kill(pid, 9); } catch {}
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
        case "tool_use":
          console.log(`[${label}] Tool use: ${event.detail}`);
          emitActivity(`🔧 ${event.detail}`);
          for (const cb of toolUseCallbacks) cb(event.detail);
          break;
        case "rate_limit":
          rateLimitDetected = true;
          break;
        case "log":
          console.log(`[${label}] ${event.message}`);
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
      rateLimitDetected = false;
      pendingRetry = true;
      console.log(`[${label}] Rate limited — retrying in ${RATE_LIMIT_RETRY_DELAY / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})`);

      for (const cb of rateLimitCallbacks) {
        cb(RATE_LIMIT_RETRY_DELAY / 1000, rateLimitRetryCount);
      }

      setTimeout(() => {
        pendingRetry = false;
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
        cb(delay / 1000, apiErrorRetryCount, API_ERROR_RETRY_DELAYS.length);
      }

      setTimeout(() => {
        pendingRetry = false;
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
      if (resolver) resolver.resolve("[API error — retried but still failing. Try again later.]");
      return;
    }

    rateLimitDetected = false;
    rateLimitRetryCount = 0;
    apiErrorRetryCount = 0;

    console.log(`[${label}] Result received (${responseText.length} chars), resolvers waiting: ${responseResolvers.length}`);
    emitActivity(`✅ Done (${responseText.length} chars)`);
    const resolver = responseResolvers.shift();
    if (resolver) {
      resolver.resolve(responseText);
    }
  }

  // -- Public API --

  function isAlive(): boolean {
    return alive;
  }

  /** Synchronous SIGKILL — for use in SIGTERM/SIGINT handlers */
  function forceKill(): void {
    if (!proc) return;
    alive = false;
    stopHealthCheck();
    try { proc.kill("SIGKILL"); } catch {}
    proc = null;
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

  function onActivity(cb: (line: string) => void): void {
    activityCallbacks.push(cb);
  }

  function onToolUse(cb: (detail: string) => void): void {
    toolUseCallbacks.push(cb);
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

  return { isAlive, send, waitForResponse, kill, forceKill, onExit, onChunk, onRateLimit, onApiError, onActivity, onToolUse, getStatus };
}
