import path from "path";
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
  let activityCallbacks: Array<(line: string) => void> = [];
  let toolUseCallbacks: Array<(detail: string) => void> = [];
  // Response queue: resolvers waiting for result messages
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
  const spawnedPids = new Set<number>(); // track all PIDs we've ever spawned

  function startHealthCheck(): void {
    stopHealthCheck();
    healthCheckTimer = setInterval(() => {
      if (!proc || !alive) {
        stopHealthCheck();
        return;
      }

      // Check if the process PID still exists (signal 0 = existence check)
      try {
        process.kill(proc.pid, 0);
      } catch {
        // Process is gone but we didn't get an exit event
        console.error(`[claude] Health check: process ${proc.pid} is dead (likely OOM killed)`);
        emitActivity(`❌ Process died unexpectedly (pid ${proc.pid})`);

        alive = false;
        proc = null;
        stopHealthCheck();

        // Resolve any pending response resolvers
        const pending = responseResolvers;
        responseResolvers = [];
        for (const { resolve } of pending) {
          if (accumulatedText) {
            resolve(accumulatedText);
          } else {
            resolve("[Claude process was killed unexpectedly (possibly OOM). Try again.]");
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

  // Orphan checker: every 30s, verify no stale Claude processes are alive
  const orphanCheckTimer = setInterval(() => {
    const currentPid = proc?.pid;
    for (const pid of spawnedPids) {
      if (pid === currentPid) continue;
      try {
        process.kill(pid, 0); // existence check — throws if dead
        // Still alive — this is an orphan
        console.error(`[claude] ORPHAN DETECTED: pid ${pid} still alive (current: ${currentPid ?? "none"}) — killing`);
        try { process.kill(pid, 9); } catch {}
        spawnedPids.delete(pid);
      } catch {
        // Process is dead, clean it from the set
        spawnedPids.delete(pid);
      }
    }
  }, 30_000);
  // Don't let this timer keep the process alive
  if (orphanCheckTimer.unref) orphanCheckTimer.unref();

  function emitActivity(line: string): void {
    for (const cb of activityCallbacks) cb(line);
  }

  function shortPath(p: string): string {
    const dir = path.basename(path.dirname(p));
    const file = path.basename(p);
    return dir && dir !== "." ? `${dir}/${file}` : file;
  }

  function formatToolUse(name: string, input: any): string {
    switch (name) {
      case "Read": return `Read ${input?.file_path ? shortPath(input.file_path) : ""}`;
      case "Edit": return `Edit ${input?.file_path ? shortPath(input.file_path) : ""}`;
      case "Write": return `Write ${input?.file_path ? shortPath(input.file_path) : ""}`;
      case "Bash": return `Bash: ${(input?.command || "").slice(0, 120)}`;
      case "Grep": return `Grep "${input?.pattern || ""}" in ${input?.path ? shortPath(input.path) : "."}`;
      case "Glob": return `Glob ${input?.pattern || ""}`;
      case "WebSearch": return `WebSearch: ${(input?.query || "").slice(0, 100)}`;
      case "WebFetch": return `WebFetch: ${(input?.url || "").slice(0, 100)}`;
      default: return name;
    }
  }

  function spawnProcess(promptFile?: string): void {
    const tools = TOOLS_BY_MODE[config.mode];
    const args = [
      config.cliPath || "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
    ];

    if (config.model) {
      args.push("--model", config.model);
    }

    if (config.effort !== undefined) {
      args.push("--effort", config.effort);
    }

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
    spawnedPids.add(proc.pid);
    startHealthCheck();

    console.log(`[claude] Spawned process (pid: ${proc.pid})`);
    console.log(`[claude] Args: ${args.join(" ")}`);
    emitActivity(`⚡ claude spawned (pid ${proc.pid})`);

    // Read stdout as NDJSON — keep promise so exit handler can wait for it
    stdoutDone = readOutputStream();

    // Read stderr for logging
    readErrorStream();

    // Handle process exit — wait for stdout to drain before resolving
    const thisProc = proc;
    proc.exited.then(async (code) => {
      // Wait for stdout reader to finish so all output (including the
      // result message) is processed before we touch resolvers.
      await stdoutDone;

      // If a newer process has been spawned, this exit is stale — ignore it.
      if (proc !== thisProc) {
        console.log(`[claude] Stale exit ignored (pid was ${thisProc.pid})`);
        return;
      }

      alive = false;
      stopHealthCheck();

      if (code !== 0) {
        console.error(`[claude] Process exited with code ${code}`);
        emitActivity(`❌ Process exited with code ${code}`);
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
            } else if (block.type === "tool_use") {
              const detail = formatToolUse(block.name, block.input);
              console.log(`[claude] Tool use: ${detail}`);
              emitActivity(`🔧 ${detail}`);
              for (const cb of toolUseCallbacks) cb(detail);
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

            // Kill old process if still alive before spawning new one
            forceKill();

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

            // Kill old process if still alive before spawning new one
            forceKill();

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
        emitActivity(`✅ Done (${responseText.length} chars)`);
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
      console.error("[claude] WARNING: send() called with running process — killing old one");
      forceKill();
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
    stopHealthCheck();

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
      backend: "claude",
    };
  }

  return { isAlive, send, waitForResponse, kill, forceKill, onExit, onChunk, onRateLimit, onApiError, onActivity, onToolUse, getStatus };
}
