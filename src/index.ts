#!/usr/bin/env bun

import "@session.js/bun-network";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { Config, Mode } from "./types.js";
import { createProxy } from "./proxy.js";

function parseArgs(): Config {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: snoot <channel> [options]

Options:
  --user <session-id>   User's Session ID (required on first run)
  --mode <mode>         Tool mode: chat, research, coding (default: coding)
  --timeout <seconds>   Idle timeout before killing Claude process (default: 90)
  --budget <usd>        Max budget per Claude process in USD (default: 1.00)
  --compact-at <n>      Trigger compaction at N message pairs (default: 20)
  --window <n>          Keep N pairs after compaction (default: 15)
`);
    process.exit(0);
  }

  const channel = args[0];
  let userSessionId = "";
  let mode: Mode = "coding";
  let idleTimeout = 90;
  let budgetUsd = 1.0;
  let compactAt = 20;
  let windowSize = 15;

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
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  // Resolve base directory
  const baseDir = resolve(`.snoot/${channel}`);
  const userFile = `${baseDir}/user.json`;

  // Load or save user Session ID
  if (userSessionId) {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(userFile, JSON.stringify({ sessionId: userSessionId }));
  } else if (existsSync(userFile)) {
    const data = JSON.parse(readFileSync(userFile, "utf-8"));
    userSessionId = data.sessionId;
  } else {
    console.error(
      `No user Session ID configured. Run with --user <session-id> on first use.`
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

async function main(): Promise<void> {
  const config = parseArgs();
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
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
