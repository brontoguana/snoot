import type { Config, ClaudeManager, StreamJsonOutput } from "./types.js";
import { TOOLS_BY_MODE } from "./types.js";

export function createClaudeManager(config: Config): ClaudeManager {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let alive = false;
  let exitCallbacks: Array<() => void> = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Response queue: resolvers waiting for result messages
  let responseResolvers: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }> = [];
  let accumulatedText = "";

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log("[claude] Idle timeout reached, shutting down process");
      kill();
    }, config.idleTimeout * 1000);
  }

  function spawnProcess(): void {
    const tools = TOOLS_BY_MODE[config.mode];
    const args = [
      "claude",
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--max-budget-usd", config.budgetUsd.toString(),
      "--no-session-persistence",
    ];

    if (tools) {
      args.push("--tools", tools);
    } else {
      // chat mode: no tools
      args.push("--tools", "");
    }

    const env = { ...process.env };
    delete env.CLAUDECODE; // prevent nested session detection

    proc = Bun.spawn(args, {
      cwd: config.workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    alive = true;
    accumulatedText = "";
    resetIdleTimer();

    console.log(`[claude] Spawned process (pid: ${proc.pid})`);
    console.log(`[claude] Args: ${args.join(" ")}`);

    // Read stdout as NDJSON
    readOutputStream();

    // Read stderr for logging
    readErrorStream();

    // Handle process exit
    proc.exited.then((code) => {
      alive = false;
      if (idleTimer) clearTimeout(idleTimer);

      if (code !== 0) {
        console.error(`[claude] Process exited with code ${code}`);
      } else {
        console.log("[claude] Process exited normally");
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
          // Process exited cleanly but no response — idle timeout or empty result
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
          resetIdleTimer();

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
            }
          }
        }
        break;
      }
      case "result": {
        // Response complete — resolve the oldest waiting promise
        const result = (msg as any).result as string;
        // Use the result text if available, otherwise use accumulated text
        const responseText = result || accumulatedText;
        accumulatedText = "";

        console.log(`[claude] Result received (${responseText.length} chars), resolvers waiting: ${responseResolvers.length}`);
        const resolver = responseResolvers.shift();
        if (resolver) {
          resolver.resolve(responseText);
        }
        break;
      }
      default:
        // system, stream_event, etc. — ignore
        break;
    }
  }

  function isAlive(): boolean {
    return alive;
  }

  function send(text: string, isInitial?: boolean, contextPrefix?: string): void {
    if (!alive) {
      spawnProcess();
    }

    const content = isInitial && contextPrefix
      ? contextPrefix + "\n\n---\n\n" + text
      : text;

    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    }) + "\n";

    try {
      const stdin = proc!.stdin as import("bun").FileSink;
      stdin.write(message);
      stdin.flush();
      resetIdleTimer();
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
    if (idleTimer) clearTimeout(idleTimer);

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

  return { isAlive, send, waitForResponse, kill, onExit };
}
