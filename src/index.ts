#!/usr/bin/env bun

import "@session.js/bun-network";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, openSync, appendFileSync, watch as fsWatchFile } from "fs";
import { resolve, dirname, basename, parse as parsePath, delimiter as PATH_DELIMITER } from "path";
import { homedir } from "os";
import type { Config, Mode, Backend, Transport, MatrixConfig } from "./types.js";
import { createProxy } from "./proxy.js";

const SNOOT_SRC = import.meta.filename;
const GLOBAL_SNOOT_DIR = resolve(homedir(), ".snoot");

const IS_WINDOWS = process.platform === "win32";

// Detect compiled mode: use build-time define if available, else check for $bunfs virtual path
// On Linux: /$bunfs/root/index, on Windows: C:\$bunfs\root\index or similar
declare var __SNOOT_COMPILED__: boolean | undefined;
const IS_COMPILED = (typeof __SNOOT_COMPILED__ !== "undefined" && __SNOOT_COMPILED__) ||
  SNOOT_SRC.includes("$bunfs");

// Compiled argv varies by platform:
//   Linux compiled: ["execPath", ...args]           → offset 1
//   Windows compiled: ["bun", "$bunfs/...", ...args] → offset 2
//   Interpreted: ["bun", "script.ts", ...args]       → offset 2
const ARGV_OFFSET = IS_COMPILED && !IS_WINDOWS ? 1 : 2;

// Ensure CLI tools directory is in PATH — cron/@reboot entries and PowerShell detached
// processes inherit a minimal PATH that may not include user directories where
// claude/gemini CLIs are installed.
const EXTRA_PATH_DIRS: string[] = [];
if (IS_WINDOWS) {
  const appData = process.env.APPDATA || resolve(homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), "AppData", "Local");
  EXTRA_PATH_DIRS.push(
    resolve(localAppData, "snoot"),                    // our own binary
    resolve(appData, "npm"),                           // npm global bin (claude.cmd)
    resolve(localAppData, "Microsoft", "WinGet", "Links"), // winget symlinks
    resolve(homedir(), ".bun", "bin"),                 // bun global bin
  );
} else {
  EXTRA_PATH_DIRS.push(resolve(homedir(), ".local", "bin"));
}
const currentPath = process.env.PATH?.split(PATH_DELIMITER) || [];
for (const dir of EXTRA_PATH_DIRS) {
  if (!currentPath.includes(dir)) {
    process.env.PATH = `${dir}${PATH_DELIMITER}${process.env.PATH || ""}`;
  }
}
const INSTANCES_DIR = resolve(GLOBAL_SNOOT_DIR, "instances");

// Find the full path to a CLI tool (claude or gemini).
// On Windows, Bun.spawn doesn't resolve .cmd/.bat extensions, so we search explicitly.
function findCliPath(name: string): string | undefined {
  const extensions = IS_WINDOWS ? [".cmd", ".bat", ".exe", ""] : [""];
  const pathDirs = (process.env.PATH || "").split(PATH_DELIMITER);

  // Also search common install locations not always in PATH
  const extraDirs: string[] = [];
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA || resolve(homedir(), "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), "AppData", "Local");
    extraDirs.push(
      resolve(appData, "npm"),
      resolve(localAppData, "Microsoft", "WinGet", "Links"),
      resolve(localAppData, "Programs", "claude-code"),  // MSI installer
      resolve(homedir(), ".bun", "bin"),
      resolve(homedir(), "scoop", "shims"),              // scoop
    );
  }

  const allDirs = [...pathDirs, ...extraDirs];
  for (const dir of allDirs) {
    for (const ext of extensions) {
      const candidate = resolve(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// Build a command to spawn ourselves.
// In compiled mode, process.execPath IS the binary — no script arg needed.
// In interpreted mode, we need: bun <script> <args>
function selfCommand(...extraArgs: string[]): string[] {
  if (IS_COMPILED) return [process.execPath, ...extraArgs];
  return [process.execPath, SNOOT_SRC, ...extraArgs];
}

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
  const { root } = parsePath(dir);
  while (dir !== root) {
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
    console.error("  (deprecated — use 'snoot setup session <id>' instead)");
    process.exit(1);
  }

  // Write both old format (backward compat) and new config format
  mkdirSync(GLOBAL_SNOOT_DIR, { recursive: true });
  const userFile = resolve(GLOBAL_SNOOT_DIR, "user.json");
  writeFileSync(userFile, JSON.stringify({ sessionId }));

  const configFile = resolve(GLOBAL_SNOOT_DIR, "config.json");
  const existing = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf-8")) : {};
  existing.transport = "session";
  existing.userId = sessionId;
  writeFileSync(configFile, JSON.stringify(existing, null, 2));

  console.log(`Global user Session ID saved.`);
  console.log(`  (Tip: use 'snoot setup session <id>' going forward)`);
  process.exit(0);
}

interface GlobalConfig {
  transport: Transport;
  userId: string;
  matrixHomeserver?: string;
  matrixAccessToken?: string;
  matrixDeviceId?: string;
  budgetUsd?: number;
}

function loadGlobalConfig(): GlobalConfig | null {
  const configFile = resolve(GLOBAL_SNOOT_DIR, "config.json");
  if (!existsSync(configFile)) return null;
  try {
    return JSON.parse(readFileSync(configFile, "utf-8"));
  } catch {
    return null;
  }
}

function saveGlobalConfig(config: GlobalConfig): void {
  mkdirSync(GLOBAL_SNOOT_DIR, { recursive: true });
  const configFile = resolve(GLOBAL_SNOOT_DIR, "config.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));
}

function detectTransport(userId: string): Transport {
  // @user:server = Matrix, 05<hex> = Session
  if (userId.startsWith("@") && userId.includes(":")) return "matrix";
  return "session";
}

async function handleSetup(args: string[]): Promise<never> {
  const transport = args[0]?.toLowerCase() as Transport | undefined;

  if (!transport || !["session", "matrix"].includes(transport)) {
    console.log(`Usage:
  snoot setup session <session-id>
  snoot setup matrix <@user:server> [--homeserver <url>] [--token <access-token>]

Current config:`);
    const cfg = loadGlobalConfig();
    if (cfg) {
      console.log(`  Transport: ${cfg.transport}`);
      console.log(`  User: ${cfg.userId}`);
      if (cfg.matrixHomeserver) console.log(`  Homeserver: ${cfg.matrixHomeserver}`);
    } else {
      console.log("  (not configured)");
    }
    process.exit(0);
  }

  if (transport === "session") {
    const sessionId = args[1];
    if (!sessionId) {
      console.error("Usage: snoot setup session <session-id>");
      process.exit(1);
    }

    const existing = loadGlobalConfig() || {} as GlobalConfig;
    const wasMatrix = existing.transport === "matrix";
    const config: GlobalConfig = {
      ...existing,
      transport: "session",
      userId: sessionId,
    };
    saveGlobalConfig(config);

    // Also write legacy user.json for backward compat
    writeFileSync(resolve(GLOBAL_SNOOT_DIR, "user.json"), JSON.stringify({ sessionId }));

    console.log(`Transport: session`);
    console.log(`User ID: ${sessionId}`);
    console.log(`Saved to ~/.snoot/config.json`);

    if (wasMatrix) {
      await restartAllInstances("Transport switched to session");
    }
    process.exit(0);
  }

  if (transport === "matrix") {
    const matrixUser = args[1];
    if (!matrixUser || !matrixUser.startsWith("@") || !matrixUser.includes(":")) {
      console.error("Usage: snoot setup matrix <@user:server> [--homeserver <url>] [--token <access-token>]");
      console.error("  Example: snoot setup matrix @me:matrix.org --homeserver https://matrix.org --token syt_...");
      process.exit(1);
    }

    // Parse optional flags
    let homeserver = "";
    let accessToken = "";

    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--homeserver" || args[i] === "--hs") {
        homeserver = args[++i] || "";
      } else if (args[i] === "--token") {
        accessToken = args[++i] || "";
      }
    }

    // Auto-derive homeserver from user ID if not specified
    if (!homeserver) {
      const server = matrixUser.split(":")[1];
      homeserver = `https://${server}`;
      console.log(`Homeserver not specified, using: ${homeserver}`);
    }

    // If no token provided, prompt for password
    if (!accessToken) {
      console.log(`No --token provided. Attempting password login...`);
      const password = await promptPassword(`Password for ${matrixUser}: `);
      if (!password) {
        console.error("No password provided. Use --token instead if you have an access token.");
        process.exit(1);
      }

      try {
        const sdk = await import("matrix-js-sdk");
        const tempClient = sdk.createClient({ baseUrl: homeserver });
        const loginResult = await tempClient.login("m.login.password", {
          user: matrixUser,
          password,
          initial_device_display_name: "Snoot",
        });
        accessToken = loginResult.access_token;
        console.log(`Login successful. Device ID: ${loginResult.device_id}`);
        tempClient.stopClient();
      } catch (err) {
        console.error(`Login failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    }

    // Validate token
    try {
      const sdk = await import("matrix-js-sdk");
      const tempClient = sdk.createClient({
        baseUrl: homeserver,
        accessToken,
      });
      const whoami = await tempClient.whoami();
      console.log(`Verified: ${whoami.user_id}`);
      tempClient.stopClient();
    } catch (err) {
      console.error(`Token validation failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const existing = loadGlobalConfig() || {} as GlobalConfig;
    const wasSession = existing.transport === "session" || !existing.transport;
    const config: GlobalConfig = {
      ...existing,
      transport: "matrix",
      userId: matrixUser,
      matrixHomeserver: homeserver,
      matrixAccessToken: accessToken,
    };
    saveGlobalConfig(config);

    console.log(`\nTransport: matrix`);
    console.log(`User ID: ${matrixUser}`);
    console.log(`Homeserver: ${homeserver}`);
    console.log(`Saved to ~/.snoot/config.json`);

    if (wasSession && loadInstances().length > 0) {
      await restartAllInstances("Transport switched to matrix");
    }
    process.exit(0);
  }

  process.exit(0);
}

async function promptPassword(prompt: string): Promise<string> {
  const { createInterface } = await import("readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    // Note: this won't hide input in all terminals, but it's the best we can do without raw mode
    process.stderr.write(prompt);
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}

async function restartAllInstances(reason: string): Promise<void> {
  const instances = loadInstances();
  const alive = instances.filter(i => isAlive(i.pid));

  if (alive.length === 0) {
    console.log("No running instances to restart.");
    return;
  }

  console.log(`\n${reason} — restarting ${alive.length} instance(s)...`);
  for (const inst of alive) {
    killInstance(inst);
    const launchArgs = inst.args.length > 0 ? inst.args : [inst.channel];
    console.log(`  Restarting "${inst.channel}"...`);
    const child = Bun.spawn(selfCommand(...launchArgs), {
      cwd: inst.cwd,
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    child.unref();
  }
  console.log("Done.");
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
  if (IS_WINDOWS) {
    if (/^[a-zA-Z0-9._\-\/\\=:@]+$/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
  }
  if (/^[a-zA-Z0-9._\-\/=:@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// --- Boot persistence (cron on Linux, scheduled tasks on Windows) ---

function getCrontab(): string {
  const result = Bun.spawnSync(["crontab", "-l"]);
  if (result.exitCode !== 0) return "";
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

function windowsTaskExists(channel: string): boolean {
  const result = Bun.spawnSync(["schtasks", "/query", "/tn", `snoot-${channel}`], {
    stdout: "pipe", stderr: "pipe",
  });
  return result.exitCode === 0;
}

function handleCron(): never {
  const instances = loadInstances();

  if (instances.length === 0) {
    console.log("No snoot instances in registry. Start instances first, then run 'snoot cron'.");
    process.exit(1);
  }

  if (IS_WINDOWS) {
    // Windows: create scheduled tasks with startup .bat files
    const batDir = resolve(GLOBAL_SNOOT_DIR, "startup");
    mkdirSync(batDir, { recursive: true });
    let added = 0;

    for (const inst of instances) {
      if (windowsTaskExists(inst.channel)) {
        console.log(`  ${inst.channel} — already scheduled, skipping`);
        continue;
      }

      const quotedArgs = inst.args.map(shellQuote).join(" ");
      const selfPath = IS_COMPILED
        ? `"${process.execPath}"`
        : `"${process.execPath}" "${SNOOT_SRC}"`;

      // Write a .bat file that cds to the project and launches snoot
      const batPath = resolve(batDir, `${inst.channel}.bat`);
      const batContent = `@echo off\r\ncd /d "${inst.cwd}"\r\n${selfPath} ${quotedArgs}\r\n`;
      writeFileSync(batPath, batContent);

      const result = Bun.spawnSync([
        "schtasks", "/create",
        "/tn", `snoot-${inst.channel}`,
        "/tr", `"${batPath}"`,
        "/sc", "onlogon",
        "/f",
      ], { stdout: "pipe", stderr: "pipe" });

      if (result.exitCode === 0) {
        console.log(`  ${inst.channel} — added`);
        added++;
      } else {
        console.error(`  ${inst.channel} — failed: ${result.stderr.toString().trim()}`);
      }
    }

    if (added === 0) {
      console.log("All instances already scheduled.");
    } else {
      console.log(`Added ${added} scheduled task(s).`);
    }
  } else {
    // Linux: add @reboot cron entries
    const currentCrontab = getCrontab();

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
      const selfCmd = IS_COMPILED
        ? shellQuote(process.execPath)
        : `${shellQuote(bunPath)} ${shellQuote(SNOOT_SRC)}`;
      const localBin = resolve(homedir(), ".local", "bin");
      const entry = `@reboot export PATH="${localBin}:$PATH" && cd ${shellQuote(inst.cwd)} && ${selfCmd} ${quotedArgs} # snoot:${inst.channel}`;
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
  }

  process.exit(0);
}

function handleNocron(): never {
  if (IS_WINDOWS) {
    // Windows: delete snoot-* scheduled tasks and .bat files
    const instances = loadInstances();
    const batDir = resolve(GLOBAL_SNOOT_DIR, "startup");
    let removed = 0;

    for (const inst of instances) {
      if (windowsTaskExists(inst.channel)) {
        const result = Bun.spawnSync([
          "schtasks", "/delete",
          "/tn", `snoot-${inst.channel}`,
          "/f",
        ], { stdout: "pipe", stderr: "pipe" });
        if (result.exitCode === 0) {
          console.log(`  Removed: ${inst.channel}`);
          removed++;
        }
      }
      // Clean up .bat file
      try { unlinkSync(resolve(batDir, `${inst.channel}.bat`)); } catch {}
    }

    if (removed === 0) {
      console.log("No snoot scheduled tasks found.");
    } else {
      console.log(`Removed ${removed} scheduled task(s).`);
    }
  } else {
    // Linux: remove snoot @reboot entries from crontab
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
  }

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
  let inboxPath: string;
  if (inst) {
    const baseDir = resolve(inst.cwd, `.snoot/${inst.channel}`);
    watchLogPath = resolve(baseDir, "watch.log");
    inboxPath = resolve(baseDir, "inbox");
  } else {
    const baseDir = resolve(`.snoot/${channel}`);
    watchLogPath = resolve(baseDir, "watch.log");
    inboxPath = resolve(baseDir, "inbox");
  }

  if (!existsSync(watchLogPath)) {
    console.log(`No watch log found for channel "${channel}".`);
    console.log(`Is snoot running? Start it with: snoot ${channel}`);
    process.exit(1);
  }

  const displayName = inst ? inst.channel : channel;
  console.log(`Watching snoot "${displayName}"... (Ctrl+C to stop)`);
  console.log(`Type a message and press Enter to send.\n`);

  // Read user input from terminal and write to inbox for proxy to pick up
  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    appendFileSync(inboxPath, JSON.stringify({ text: trimmed, ts: Date.now() }) + "\n");
  });

  if (IS_WINDOWS) {
    // Pure TS file tail (no tail command on Windows)
    const existing = readFileSync(watchLogPath, "utf-8");
    process.stdout.write(existing);
    let charOffset = existing.length;

    const watcher = fsWatchFile(watchLogPath, () => {
      try {
        const content = readFileSync(watchLogPath, "utf-8");
        if (content.length > charOffset) {
          process.stdout.write(content.slice(charOffset));
          charOffset = content.length;
        }
      } catch {}
    });

    process.on("SIGINT", () => {
      rl.close();
      watcher.close();
      process.exit(0);
    });

    await new Promise(() => {});
  } else {
    // Linux/macOS: use tail -f for efficient streaming
    const child = Bun.spawn(["tail", "-f", "-n", "+1", watchLogPath], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });

    process.on("SIGINT", () => {
      rl.close();
      child.kill();
      process.exit(0);
    });

    await child.exited;
  }

  process.exit(0);
}

function handleRestart(args: string[]): never {
  const channel = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  const instances = loadInstances();

  // Find instances to restart — includes dead instances so crash recovery works
  const toRestart = channel
    ? instances.filter(i => i.channel === channel)
    : instances;

  if (toRestart.length === 0) {
    console.log("No snoot instances found in registry to restart.");
    process.exit(1);
  }

  for (const inst of toRestart) {
    // Kill existing
    killInstance(inst);

    // Re-launch with saved args from registry
    const launchArgs = inst.args.length > 0 ? inst.args : [inst.channel];
    console.log(`Restarting channel "${inst.channel}" with args: ${launchArgs.join(" ")}`);
    const child = Bun.spawn(selfCommand(...launchArgs), {
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

function resolveUserId(cliUserId: string, baseDir: string): string {
  // 1. CLI --user flag (highest priority)
  if (cliUserId) return cliUserId;

  // 2. Project-local user.json
  const localUserFile = `${baseDir}/user.json`;
  if (existsSync(localUserFile)) {
    const data = JSON.parse(readFileSync(localUserFile, "utf-8"));
    if (data.sessionId) return data.sessionId;
  }

  // 3. Global config.json (new format)
  const globalConfig = loadGlobalConfig();
  if (globalConfig?.userId) return globalConfig.userId;

  // 4. Global ~/.snoot/user.json (legacy)
  const globalUserFile = resolve(GLOBAL_SNOOT_DIR, "user.json");
  if (existsSync(globalUserFile)) {
    const data = JSON.parse(readFileSync(globalUserFile, "utf-8"));
    if (data.sessionId) return data.sessionId;
  }

  return "";
}

async function parseArgs(): Promise<Config & { foreground: boolean }> {
  const args = process.argv.slice(ARGV_OFFSET);

  if (args[0] === "--version" || args[0] === "-v") {
    const { VERSION } = await import("./version.js");
    console.log(`Snoot v${VERSION}`);
    process.exit(0);
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: snoot <channel> [options]
       snoot setup session <session-id>
       snoot setup matrix <@user:server> [--homeserver <url>] [--token <token>]
       snoot shutdown [channel]
       snoot restart [channel]
       snoot watch <channel>
       snoot ps
       snoot cron
       snoot nocron

Options:
  --user <id>           User ID (overrides saved — Session hex or Matrix @user:server)
  --mode <mode>         Tool mode: chat, research, coding (default: coding)
  --backend <backend>   LLM backend: claude, gemini (default: claude)
  --budget <usd>        Max budget per message in USD (no limit by default)
  --compact-at <n>      Trigger compaction at N message pairs (default: 20)
  --window <n>          Keep N pairs after compaction (default: 15)
  --fg                  Run in foreground instead of daemonizing

Commands:
  setup session <id>    Configure Session transport with your Session ID.
  setup matrix <user>   Configure Matrix transport. Use --homeserver and --token,
                        or omit --token to login with password interactively.
  shutdown [channel]    Stop running instance(s). Omit channel to stop all.
  restart [channel]     Restart instance(s) with saved args. Omit channel to restart all.
  watch <channel>       Watch live activity (tool use, spawns, responses) in real time.
  ps                    List all snoot instances, their status, and project directories.
  cron                  Add startup entries for all registered instances.
  nocron                Remove all snoot startup entries.
  set-user <session-id> (deprecated) Use 'snoot setup session <id>' instead.
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

  if (args[0] === "setup") {
    await handleSetup(args.slice(1));
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
  let cliUserId = "";
  let mode: Mode = "coding";
  let backend: Backend = "claude";
  let budgetUsd: number | undefined = undefined;
  let compactAt = 20;
  let windowSize = 15;
  let foreground = false;
  let backendFromCli = false;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--user":
        cliUserId = args[++i] ?? "";
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
        backendFromCli = true;
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

  // Resolve user ID: --user > local > global config > legacy user.json
  const userId = resolveUserId(cliUserId, baseDir);

  // Save to project-local if provided via --user
  if (userId && args.some((a, i) => a === "--user" && args[i + 1])) {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(`${baseDir}/user.json`, JSON.stringify({ sessionId: userId }));
  }

  if (!userId) {
    console.error(
      `No user ID configured.\n` +
      `  Run: snoot setup session <session-id>    (Session transport)\n` +
      `  Or:  snoot setup matrix <@user:server>   (Matrix transport)\n` +
      `  Or:  snoot ${channel} --user <id>        (per-project override)`
    );
    process.exit(1);
  }

  // Resolve transport from global config or auto-detect from user ID format
  const globalConfig = loadGlobalConfig();
  let transport: Transport = globalConfig?.transport || detectTransport(userId);

  // Build Matrix config if needed
  let matrixConfig: MatrixConfig | undefined;
  if (transport === "matrix") {
    if (globalConfig?.matrixHomeserver && globalConfig?.matrixAccessToken) {
      matrixConfig = {
        homeserver: globalConfig.matrixHomeserver,
        accessToken: globalConfig.matrixAccessToken,
      };
    } else {
      console.error(
        `Matrix transport selected but not configured.\n` +
        `  Run: snoot setup matrix <@user:server> --homeserver <url> --token <token>`
      );
      process.exit(1);
    }
  }

  // Load persisted settings (backend/model/effort) — CLI args override saved values
  const settingsPath = `${baseDir}/settings.json`;
  if (existsSync(settingsPath)) {
    try {
      const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!backendFromCli && saved.backend && ["claude", "gemini"].includes(saved.backend)) {
        backend = saved.backend;
      }
      // model and effort are not CLI args, always restore from saved
      if (saved.model) var savedModel: string | undefined = saved.model;
      if (saved.effort) var savedEffort: string | undefined = saved.effort;
    } catch {}
  }

  // Resolve budget: --budget flag > global config > no limit
  if (budgetUsd === undefined && globalConfig?.budgetUsd !== undefined) {
    budgetUsd = globalConfig.budgetUsd;
  }

  // Resolve CLI binary path
  const cliName = backend === "gemini" ? "gemini" : "claude";
  const cliPath = findCliPath(cliName);

  return {
    channel,
    transport,
    userId,
    matrixConfig,
    mode,
    backend,
    model: savedModel,
    effort: savedEffort,
    budgetUsd,
    compactAt,
    windowSize,
    baseDir,
    workDir: process.cwd(),
    cliPath,
    selfCommand: selfCommand(...args),
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
  mkdirSync(dirname(logFile), { recursive: true });
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
  // Catch network errors from Session internals instead of crashing.
  // Session's Poller can throw unhandled rejections when snode fetches fail
  // (e.g., network blip, DNS failure, boot before network ready).
  process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const isNetwork = /fetch|snode|swarm|network|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT/i.test(msg);
    if (isNetwork) {
      console.error("[session] Network error (non-fatal, will retry):", msg);
    } else {
      console.error("[FATAL] Uncaught exception:", err);
    }
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const isNetwork = /fetch|snode|swarm|network|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT/i.test(msg);
    if (isNetwork) {
      console.error("[session] Network rejection (non-fatal, will retry):", msg);
    } else {
      console.error("[FATAL] Unhandled rejection:", reason);
    }
  });

  // Check if we're the daemon child (re-spawned in background)
  const isDaemon = process.env.SNOOT_DAEMON === "1";

  const config = await parseArgs();

  // If not --fg and not already the daemon, spawn ourselves in the background
  if (!config.foreground && !isDaemon) {
    const logFile = resolve(`.snoot/${config.channel}/snoot.log`);
    mkdirSync(dirname(logFile), { recursive: true });

    if (IS_WINDOWS) {
      // Windows: use PowerShell Start-Process to create a truly detached process.
      // Bun.spawn + child.unref() doesn't work — the child shares the parent's
      // console and gets killed when the parent exits.
      const selfArgs = selfCommand(...process.argv.slice(ARGV_OFFSET));
      const exe = selfArgs[0];
      const argList = selfArgs.slice(1).map(a => shellQuote(a)).join(" ");

      // Build PowerShell command that sets SNOOT_DAEMON=1 then launches the process
      const psCmd = [
        `$env:SNOOT_DAEMON='1';`,
        `Start-Process`,
        `-FilePath '${exe.replace(/'/g, "''")}'`,
        ...(argList ? [`-ArgumentList '${argList.replace(/'/g, "''")}'`] : []),
        `-WorkingDirectory '${process.cwd().replace(/'/g, "''")}'`,
        `-WindowStyle Hidden`,
        `-RedirectStandardOutput '${logFile.replace(/'/g, "''")}'`,
        `-RedirectStandardError '${logFile.replace(/'/g, "''").replace(/\.log$/, ".err")}'`,
      ].join(" ");

      Bun.spawnSync(["powershell", "-NoProfile", "-Command", psCmd], {
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
      });

      // Brief pause then verify the child started
      await Bun.sleep(2000);

      // Check if PID file was written by the child
      const pidFile = resolve(`.snoot/${config.channel}/snoot.pid`);
      if (existsSync(pidFile)) {
        const childPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        console.log(`Snoot started in background (pid ${childPid})`);
      } else {
        console.log(`Snoot starting in background...`);
      }
    } else {
      // Linux/macOS: Bun.spawn + unref works fine
      const logFd = openSync(logFile, "a");

      const child = Bun.spawn(selfCommand(...process.argv.slice(ARGV_OFFSET)), {
        cwd: process.cwd(),
        env: { ...process.env, SNOOT_DAEMON: "1" },
        stdout: logFd,
        stderr: logFd,
        stdin: "ignore",
      });

      child.unref();

      // Brief pause to check it didn't die immediately
      await Bun.sleep(1500);

      try {
        process.kill(child.pid, 0); // test if alive
      } catch {
        console.error(`Snoot failed to start. Check ${logFile} for details.`);
        process.exit(1);
      }

      console.log(`Snoot started in background (pid ${child.pid})`);
    }

    console.log(`  Channel: ${config.channel}`);
    console.log(`  Log: ${logFile}`);
    console.log(`  Watch: snoot watch ${config.channel}`);
    process.exit(0);
  }

  // We're either in foreground mode or the daemon child
  if (isDaemon) {
    const logFile = resolve(`.snoot/${config.channel}/snoot.log`);
    redirectToLog(logFile);
  }

  // Kill any existing instance of this channel (from any directory) via global registry
  const existing = loadInstances().find(
    i => i.channel.toLowerCase() === config.channel.toLowerCase() && isAlive(i.pid)
  );
  if (existing && existing.pid !== process.pid) {
    console.log(`Killing existing "${existing.channel}" instance (pid ${existing.pid}, cwd ${existing.cwd})...`);
    killInstance(existing);
  }

  acquireLock(config.baseDir, config.channel);

  // Save launch args so "snoot restart" can re-launch with same config
  const launchArgs = process.argv.slice(ARGV_OFFSET).filter(a => a !== "restart");
  writeFileSync(
    `${config.baseDir}/launch.json`,
    JSON.stringify({ args: launchArgs, cwd: process.cwd() })
  );

  // Register in global registry
  registerInstance(config.channel, process.cwd(), launchArgs);

  console.log(`Snoot starting (pid ${process.pid})...`);
  console.log(`  Channel: ${config.channel}`);
  console.log(`  Transport: ${config.transport}`);
  console.log(`  Backend: ${config.backend}`);
  console.log(`  Model: ${config.model || "default"}`);
  console.log(`  Effort: ${config.effort || "default"}`);
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Working dir: ${config.workDir}`);
  console.log(`  Budget: ${config.budgetUsd !== undefined ? `$${config.budgetUsd.toFixed(2)}/message` : "unlimited"}`);
  console.log(`  Compact at: ${config.compactAt} pairs, window: ${config.windowSize}`);

  console.log(`  CLI path: ${config.cliPath || "(not found)"}`);
  if (!config.cliPath) {
    console.log(`  WARNING: ${config.backend === "gemini" ? "gemini" : "claude"} not found on PATH or common install locations`);
    console.log(`  PATH: ${process.env.PATH}`);
  }

  const proxy = createProxy(config);

  // Graceful shutdown
  process.on("SIGINT", () => proxy.shutdown());
  process.on("SIGTERM", () => proxy.shutdown());

  // Retry proxy.start() with backoff — handles boot before network ready
  const START_RETRY_DELAYS = [10, 15, 30, 30, 60, 60, 120, 120, 300, 300]; // seconds
  for (let attempt = 0; ; attempt++) {
    try {
      await proxy.start();
      break; // success
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= START_RETRY_DELAYS.length) {
        console.error(`[startup] Failed after ${attempt + 1} attempts, giving up:`, msg);
        process.exit(1);
      }
      const delay = START_RETRY_DELAYS[attempt];
      console.error(`[startup] Start failed (attempt ${attempt + 1}): ${msg} — retrying in ${delay}s`);
      await Bun.sleep(delay * 1000);
    }
  }

  // Keep process alive — don't rely on Poller alone to hold the event loop
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
