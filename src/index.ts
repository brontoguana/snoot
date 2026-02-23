#!/usr/bin/env bun

import "@session.js/bun-network";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, openSync, appendFileSync } from "fs";
import { resolve, dirname, basename } from "path";
import { homedir } from "os";
import type { Config, Mode, Backend } from "./types.js";
import { createProxy } from "./proxy.js";

const SNOOT_SRC = import.meta.filename;
const GLOBAL_SNOOT_DIR = resolve(homedir(), ".snoot");
const INSTANCES_DIR = resolve(GLOBAL_SNOOT_DIR, "instances");

interface InstanceInfo {
  channel: string;
  pid: number;
  cwd: string;
  project: string;
  args: string[];
  startedAt: string;
}

function detectProjectName(cwd: string): string {
  // Walk up from cwd looking for .git or package.json
  let dir = cwd;
  while (dir !== "/") {
    if (existsSync(resolve(dir, ".git"))) {
      return basename(dir);
    }
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name) return pkg.name;
      } catch {}
      return basename(dir);
    }
    dir = dirname(dir);
  }
  return basename(cwd);
}

function registerInstance(channel: string, cwd: string, args: string[]): void {
  mkdirSync(INSTANCES_DIR, { recursive: true });
  const info: InstanceInfo = {
    channel,
    pid: process.pid,
    cwd,
    project: detectProjectName(cwd),
    args,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(INSTANCES_DIR, `${channel}.json`), JSON.stringify(info, null, 2));
}

function unregisterInstance(channel: string): void {
  try { unlinkSync(resolve(INSTANCES_DIR, `${channel}.json`)); } catch {}
}

function loadInstances(): InstanceInfo[] {
  if (!existsSync(INSTANCES_DIR)) return [];
  const instances: InstanceInfo[] = [];
  for (const entry of readdirSync(INSTANCES_DIR)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(resolve(INSTANCES_DIR, entry), "utf-8")) as InstanceInfo;
      instances.push(data);
    } catch {}
  }
  return instances;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}


function killInstance(inst: InstanceInfo): boolean {
  if (!isAlive(inst.pid)) {
    unregisterInstance(inst.channel);
    return false;
  }
  console.log(`Stopping snoot "${inst.channel}" (pid ${inst.pid})...`);
  try { process.kill(inst.pid, "SIGTERM"); } catch {}
  Bun.sleepSync(500);
  try { process.kill(inst.pid, "SIGKILL"); } catch {}
  unregisterInstance(inst.channel);
  // Also clean up PID file in the project dir
  try { unlinkSync(resolve(inst.cwd, `.snoot/${inst.channel}/snoot.pid`)); } catch {}
  return true;
}

function handleShutdown(channel?: string): never {
  const instances = loadInstances();

  if (channel) {
    const inst = instances.find(i => i.channel === channel);
    if (inst && killInstance(inst)) {
      console.log(`Snoot stopped for channel "${channel}".`);
    } else {
      console.log(`No running snoot found for channel "${channel}".`);
    }
  } else {
    let killed = 0;
    for (const inst of instances) {
      if (killInstance(inst)) {
        console.log(`  Stopped channel "${inst.channel}".`);
        killed++;
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

function handlePs(): never {
  const instances = loadInstances();

  if (instances.length === 0) {
    console.log("No snoot instances found.");
    process.exit(0);
  }

  let found = 0;
  for (const inst of instances) {
    const alive = isAlive(inst.pid);
    if (!alive) {
      // Clean up stale registry entry
      unregisterInstance(inst.channel);
      continue;
    }
    const status = `running (pid ${inst.pid})`;
    console.log(`  ${inst.channel}  ${status}  ${inst.cwd}`);
    found++;
  }

  if (found === 0) {
    console.log("No running snoot instances found.");
  }
  process.exit(0);
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-\/=:@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function getCrontab(): string {
  const result = Bun.spawnSync(["crontab", "-l"]);
  if (result.exitCode !== 0) return ""; // no crontab yet
  return result.stdout.toString();
}

function setCrontab(content: string): boolean {
  const result = Bun.spawnSync(["crontab", "-"], {
    stdin: Buffer.from(content),
  });
  if (result.exitCode !== 0) {
    console.error("Failed to update crontab:", result.stderr.toString());
    return false;
  }
  return true;
}

function handleCron(): never {
  const instances = loadInstances();

  if (instances.length === 0) {
    console.log("No snoot instances in registry. Start instances first, then run 'snoot cron'.");
    process.exit(1);
  }

  const currentCrontab = getCrontab();

  // Find which channels already have cron entries
  const existingChannels = new Set<string>();
  for (const line of currentCrontab.split("\n")) {
    const match = line.match(/# snoot:(.+)$/);
    if (match) existingChannels.add(match[1]);
  }

  const bunPath = process.execPath;
  const newEntries: string[] = [];

  for (const inst of instances) {
    if (existingChannels.has(inst.channel)) {
      console.log(`  ${inst.channel} — already in crontab, skipping`);
      continue;
    }

    const quotedArgs = inst.args.map(shellQuote).join(" ");
    const entry = `@reboot cd ${shellQuote(inst.cwd)} && ${shellQuote(bunPath)} ${shellQuote(SNOOT_SRC)} ${quotedArgs} # snoot:${inst.channel}`;
    newEntries.push(entry);
    console.log(`  ${inst.channel} — added`);
  }

  if (newEntries.length === 0) {
    console.log("All instances already in crontab.");
    process.exit(0);
  }

  const base = currentCrontab.trimEnd();
  const updatedCrontab = (base ? base + "\n" : "") + newEntries.join("\n") + "\n";

  if (!setCrontab(updatedCrontab)) {
    process.exit(1);
  }

  console.log(`Added ${newEntries.length} entry/entries to crontab.`);
  process.exit(0);
}

function handleNocron(): never {
  const currentCrontab = getCrontab();

  if (!currentCrontab.trim()) {
    console.log("No crontab found.");
    process.exit(0);
  }

  const lines = currentCrontab.split("\n");
  const kept: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const match = line.match(/# snoot:(.+)$/);
    if (match) {
      console.log(`  Removed: ${match[1]}`);
      removed++;
    } else {
      kept.push(line);
    }
  }

  if (removed === 0) {
    console.log("No snoot entries found in crontab.");
    process.exit(0);
  }

  if (!setCrontab(kept.join("\n"))) {
    process.exit(1);
  }

  console.log(`Removed ${removed} snoot entry/entries from crontab.`);
  process.exit(0);
}

async function handleWatch(args: string[]): Promise<never> {
  const channel = args[0];
  if (!channel) {
    console.error("Usage: snoot watch <channel>");
    process.exit(1);
  }

  // Find from global registry (case-insensitive) or fall back to local
  const instances = loadInstances();
  const inst = instances.find(i => i.channel.toLowerCase() === channel.toLowerCase());

  let watchLogPath: string;
  if (inst) {
    watchLogPath = resolve(inst.cwd, `.snoot/${inst.channel}/watch.log`);
  } else {
    watchLogPath = resolve(`.snoot/${channel}/watch.log`);
  }

  if (!existsSync(watchLogPath)) {
    console.log(`No watch log found for channel "${channel}".`);
    console.log(`Is snoot running? Start it with: snoot ${channel}`);
    process.exit(1);
  }

  const displayName = inst ? inst.channel : channel;
  console.log(`Watching snoot "${displayName}"... (Ctrl+C to stop)\n`);

  const child = Bun.spawn(["tail", "-f", "-n", "+1", watchLogPath], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  process.on("SIGINT", () => {
    child.kill();
    process.exit(0);
  });

  await child.exited;
  process.exit(0);
}

function handleRestart(args: string[]): never {
  const channel = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  const instances = loadInstances();

  // Find instances to restart
  const toRestart = channel
    ? instances.filter(i => i.channel === channel)
    : instances.filter(i => isAlive(i.pid));

  if (toRestart.length === 0) {
    console.log("No running snoot instances found to restart.");
    process.exit(1);
  }

  for (const inst of toRestart) {
    // Kill existing
    killInstance(inst);

    // Re-launch with saved args from registry
    const launchArgs = inst.args.length > 0 ? inst.args : [inst.channel];
    console.log(`Restarting channel "${inst.channel}" with args: ${launchArgs.join(" ")}`);
    const child = Bun.spawn(["bun", SNOOT_SRC, ...launchArgs], {
      cwd: inst.cwd,
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    child.unref();
  }

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

async function parseArgs(): Promise<Config & { foreground: boolean }> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: snoot <channel> [options]
       snoot shutdown [channel]
       snoot restart [channel]
       snoot watch <channel>
       snoot ps
       snoot cron
       snoot nocron
       snoot set-user <session-id>

Options:
  --user <session-id>   User's Session ID (overrides saved ID)
  --mode <mode>         Tool mode: chat, research, coding (default: coding)
  --backend <backend>   LLM backend: claude, gemini (default: claude)
  --budget <usd>        Max budget per message in USD (no limit by default)
  --compact-at <n>      Trigger compaction at N message pairs (default: 20)
  --window <n>          Keep N pairs after compaction (default: 15)
  --fg                  Run in foreground instead of daemonizing

Commands:
  shutdown [channel]    Stop running instance(s). Omit channel to stop all.
  restart [channel]     Restart instance(s) with saved args. Omit channel to restart all.
  watch <channel>       Watch live activity (tool use, spawns, responses) in real time.
  ps                    List all snoot instances, their status, and project directories.
  cron                  Add @reboot cron entries for all registered instances.
  nocron                Remove all snoot @reboot entries from crontab.
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

  if (args[0] === "ps") {
    handlePs();
  }

  if (args[0] === "cron") {
    handleCron();
  }

  if (args[0] === "nocron") {
    handleNocron();
  }

  if (args[0] === "watch") {
    await handleWatch(args.slice(1));
  }

  // "restart" — kill existing then re-launch with saved args
  if (args[0] === "restart") {
    handleRestart(args.slice(1));
  }

  const channel = args[0];
  let userSessionId = "";
  let mode: Mode = "coding";
  let backend: Backend = "claude";
  let budgetUsd: number | undefined = undefined;
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
      case "--backend":
        backend = (args[++i] ?? "claude") as Backend;
        if (!["claude", "gemini"].includes(backend)) {
          console.error(`Invalid backend: ${backend}. Choose: claude, gemini`);
          process.exit(1);
        }
        break;
      case "--budget":
        budgetUsd = parseFloat(args[++i] ?? "");
        if (isNaN(budgetUsd)) budgetUsd = undefined;
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

  // Resolve budget: --budget flag > global ~/.snoot/config.json > no limit
  if (budgetUsd === undefined) {
    const globalConfigFile = resolve(GLOBAL_SNOOT_DIR, "config.json");
    if (existsSync(globalConfigFile)) {
      try {
        const globalConfig = JSON.parse(readFileSync(globalConfigFile, "utf-8"));
        if (typeof globalConfig.budgetUsd === "number") {
          budgetUsd = globalConfig.budgetUsd;
        }
      } catch {}
    }
  }

  return {
    channel,
    userSessionId,
    mode,
    backend,
    budgetUsd,
    compactAt,
    windowSize,
    baseDir,
    workDir: process.cwd(),
    foreground,
  };
}

function acquireLock(baseDir: string, channel: string): void {
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
    unregisterInstance(channel);
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
  process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled rejection:", reason);
  });

  // Check if we're the daemon child (re-spawned in background)
  const isDaemon = process.env.SNOOT_DAEMON === "1";

  const config = await parseArgs();

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

  acquireLock(config.baseDir, config.channel);

  // Save launch args so "snoot restart" can re-launch with same config
  const launchArgs = process.argv.slice(2).filter(a => a !== "restart");
  writeFileSync(
    `${config.baseDir}/launch.json`,
    JSON.stringify({ args: launchArgs, cwd: process.cwd() })
  );

  // Register in global registry
  registerInstance(config.channel, process.cwd(), launchArgs);

  console.log(`Snoot starting (pid ${process.pid})...`);
  console.log(`  Channel: ${config.channel}`);
  console.log(`  Backend: ${config.backend}`);
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Working dir: ${config.workDir}`);
  console.log(`  Budget: ${config.budgetUsd !== undefined ? `$${config.budgetUsd.toFixed(2)}/message` : "unlimited"}`);
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
