#!/usr/bin/env bun

import "@session.js/bun-network";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, openSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import type { Config, Mode } from "./types.js";
import { createProxy } from "./proxy.js";

const SNOOT_SRC = import.meta.filename;
const GLOBAL_SNOOT_DIR = resolve(homedir(), ".snoot");

function killByPidFile(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  if (isNaN(pid)) return false;
  try {
    process.kill(pid, 0); // test if alive
    console.log(`Stopping snoot process (pid ${pid})...`);
    process.kill(pid, "SIGTERM");
    Bun.sleepSync(500);
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { unlinkSync(pidFile); } catch {}
    return true;
  } catch {
    // Stale PID file
    try { unlinkSync(pidFile); } catch {}
    return false;
  }
}

function handleShutdown(channel?: string): never {
  const snootDir = resolve(".snoot");
  if (!existsSync(snootDir)) {
    console.log("No .snoot directory found — nothing to shut down.");
    process.exit(0);
  }

  if (channel) {
    const pidFile = resolve(snootDir, channel, "snoot.pid");
    if (killByPidFile(pidFile)) {
      console.log(`Snoot stopped for channel "${channel}".`);
    } else {
      console.log(`No running snoot found for channel "${channel}".`);
    }
  } else {
    // Kill all channels
    let killed = 0;
    for (const entry of readdirSync(snootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const pidFile = resolve(snootDir, entry.name, "snoot.pid");
        if (killByPidFile(pidFile)) {
          console.log(`  Stopped channel "${entry.name}".`);
          killed++;
        }
      }
    }
    if (killed === 0) {
      console.log("No running snoot instances found.");
    } else {
      console.log(`Stopped ${killed} instance(s).`);
    }
  }
  process.exit(0);
}

function handleSetUser(args: string[]): never {
  const sessionId = args[0];
  if (!sessionId) {
    console.error("Usage: snoot set-user <session-id>");
    process.exit(1);
  }

  mkdirSync(GLOBAL_SNOOT_DIR, { recursive: true });
  const userFile = resolve(GLOBAL_SNOOT_DIR, "user.json");
  writeFileSync(userFile, JSON.stringify({ sessionId }));
  console.log(`Global user Session ID saved to ${userFile}`);
  process.exit(0);
}

function resolveUserSessionId(userSessionId: string, baseDir: string): string {
  // 1. CLI --user flag (highest priority)
  if (userSessionId) return userSessionId;

  // 2. Project-local user.json
  const localUserFile = `${baseDir}/user.json`;
  if (existsSync(localUserFile)) {
    const data = JSON.parse(readFileSync(localUserFile, "utf-8"));
    if (data.sessionId) return data.sessionId;
  }

  // 3. Global ~/.snoot/user.json
  const globalUserFile = resolve(GLOBAL_SNOOT_DIR, "user.json");
  if (existsSync(globalUserFile)) {
    const data = JSON.parse(readFileSync(globalUserFile, "utf-8"));
    if (data.sessionId) return data.sessionId;
  }

  return "";
}

function parseArgs(): Config & { foreground: boolean } {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: snoot <channel> [options]
       snoot shutdown [channel]
       snoot restart <channel> [options]
       snoot set-user <session-id>

Options:
  --user <session-id>   User's Session ID (overrides saved ID)
  --mode <mode>         Tool mode: chat, research, coding (default: coding)
  --timeout <seconds>   Idle timeout before killing Claude process (default: 90)
  --budget <usd>        Max budget per Claude process in USD (default: 1.00)
  --compact-at <n>      Trigger compaction at N message pairs (default: 20)
  --window <n>          Keep N pairs after compaction (default: 15)
  --fg                  Run in foreground instead of daemonizing

Commands:
  shutdown [channel]    Stop running instance(s). Omit channel to stop all.
  restart <channel>     Stop and restart a channel (same as starting with new options).
  set-user <session-id> Save your Session ID globally (~/.snoot/user.json).
`);
    process.exit(0);
  }

  // Handle subcommands
  if (args[0] === "shutdown") {
    handleShutdown(args[1]);
  }

  if (args[0] === "set-user") {
    handleSetUser(args.slice(1));
  }

  // "restart" just means kill existing then start — acquireLock handles the kill,
  // so we just strip the "restart" keyword and proceed normally
  const isRestart = args[0] === "restart";
  if (isRestart) {
    args.shift();
    if (args.length === 0) {
      console.error("Usage: snoot restart <channel> [options]");
      process.exit(1);
    }
  }

  const channel = args[0];
  let userSessionId = "";
  let mode: Mode = "coding";
  let idleTimeout = 90;
  let budgetUsd = 1.0;
  let compactAt = 20;
  let windowSize = 15;
  let foreground = false;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--user":
        userSessionId = args[++i] ?? "";
        break;
      case "--mode":
        mode = (args[++i] ?? "coding") as Mode;
        if (!["chat", "research", "coding"].includes(mode)) {
          console.error(`Invalid mode: ${mode}. Choose: chat, research, coding`);
          process.exit(1);
        }
        break;
      case "--timeout":
        idleTimeout = parseInt(args[++i] ?? "90", 10);
        break;
      case "--budget":
        budgetUsd = parseFloat(args[++i] ?? "1.00");
        break;
      case "--compact-at":
        compactAt = parseInt(args[++i] ?? "20", 10);
        break;
      case "--window":
        windowSize = parseInt(args[++i] ?? "15", 10);
        break;
      case "--fg":
        foreground = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  // Resolve base directory
  const baseDir = resolve(`.snoot/${channel}`);

  // Resolve user Session ID: --user > local > global
  userSessionId = resolveUserSessionId(userSessionId, baseDir);

  // Save to project-local if provided via --user
  if (userSessionId && args.some((a, i) => a === "--user" && args[i + 1])) {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(`${baseDir}/user.json`, JSON.stringify({ sessionId: userSessionId }));
  }

  if (!userSessionId) {
    console.error(
      `No user Session ID configured.\n` +
      `  Run: snoot set-user <session-id>     (global)\n` +
      `  Or:  snoot ${channel} --user <id>    (per-project)`
    );
    process.exit(1);
  }

  return {
    channel,
    userSessionId,
    mode,
    idleTimeout,
    budgetUsd,
    compactAt,
    windowSize,
    baseDir,
    workDir: process.cwd(),
    foreground,
  };
}

function acquireLock(baseDir: string): void {
  const lockFile = `${baseDir}/snoot.pid`;
  mkdirSync(baseDir, { recursive: true });

  // Check for existing process
  if (existsSync(lockFile)) {
    const oldPid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
    if (!isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0); // test if alive
        // Process exists — kill it
        console.log(`Killing existing snoot process (pid ${oldPid})...`);
        process.kill(oldPid, "SIGTERM");
        // Brief wait for it to die
        Bun.sleepSync(500);
        try { process.kill(oldPid, "SIGKILL"); } catch {}
      } catch {
        // Process doesn't exist, stale lock
      }
    }
  }

  // Write our PID
  writeFileSync(lockFile, String(process.pid));

  // Clean up on exit
  const cleanup = () => {
    try { unlinkSync(lockFile); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function redirectToLog(logFile: string): void {
  const fd = openSync(logFile, "a");
  const write = (data: string | Uint8Array) => {
    const str = typeof data === "string" ? data : new TextDecoder().decode(data);
    appendFileSync(fd, str);
    return true;
  };

  // Override console methods
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  const timestamp = () => new Date().toISOString();

  console.log = (...args: any[]) => {
    write(`[${timestamp()}] ${args.map(String).join(" ")}\n`);
  };
  console.error = (...args: any[]) => {
    write(`[${timestamp()}] ERROR: ${args.map(String).join(" ")}\n`);
  };
  console.warn = (...args: any[]) => {
    write(`[${timestamp()}] WARN: ${args.map(String).join(" ")}\n`);
  };
}

async function main(): Promise<void> {
  // Check if we're the daemon child (re-spawned in background)
  const isDaemon = process.env.SNOOT_DAEMON === "1";

  const config = parseArgs();

  // If not --fg and not already the daemon, spawn ourselves in the background
  if (!config.foreground && !isDaemon) {
    const logFile = resolve(`.snoot/${config.channel}/snoot.log`);
    mkdirSync(dirname(logFile), { recursive: true });

    const logFd = openSync(logFile, "a");

    const child = Bun.spawn(["bun", SNOOT_SRC, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: { ...process.env, SNOOT_DAEMON: "1" },
      stdout: logFd,
      stderr: logFd,
      stdin: "ignore",
    });

    // Detach from parent — unref so parent can exit
    child.unref();

    // Brief pause to check it didn't die immediately
    await Bun.sleep(1500);

    try {
      process.kill(child.pid, 0); // test if alive
      console.log(`Snoot started in background (pid ${child.pid})`);
      console.log(`  Channel: ${config.channel}`);
      console.log(`  Log: ${logFile}`);
      process.exit(0);
    } catch {
      console.error(`Snoot failed to start. Check ${logFile} for details.`);
      process.exit(1);
    }
  }

  // We're either in foreground mode or the daemon child
  if (isDaemon) {
    const logFile = resolve(`.snoot/${config.channel}/snoot.log`);
    redirectToLog(logFile);
  }

  acquireLock(config.baseDir);

  console.log(`Snoot starting (pid ${process.pid})...`);
  console.log(`  Channel: ${config.channel}`);
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Working dir: ${config.workDir}`);
  console.log(`  Idle timeout: ${config.idleTimeout}s`);
  console.log(`  Budget: $${config.budgetUsd.toFixed(2)}/process`);
  console.log(`  Compact at: ${config.compactAt} pairs, window: ${config.windowSize}`);

  const proxy = createProxy(config);

  // Graceful shutdown
  process.on("SIGINT", () => proxy.shutdown());
  process.on("SIGTERM", () => proxy.shutdown());

  await proxy.start();

  // Keep process alive — don't rely on Poller alone to hold the event loop
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
