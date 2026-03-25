import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join, relative, basename } from "path";
import type { Config, ContextStore, ContextState, MessagePair, PinnedItem, RecentCommand } from "./types.js";

const ARCHIVE_RETENTION_DAYS = 30;

/** Run a git command in a directory, return trimmed stdout or null on failure */
function gitCmd(dir: string, ...args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

interface RepoInfo {
  path: string;      // display path (relative to workDir or absolute)
  branch: string;
  status: string[];  // porcelain status lines
  commits: string[]; // last 2-3 oneline commits
}

/** Detect git repos: workDir itself + immediate subdirectories */
function detectGitRepos(workDir: string): RepoInfo[] {
  const repos: RepoInfo[] = [];

  function probeRepo(dir: string): RepoInfo | null {
    if (!existsSync(join(dir, ".git"))) return null;
    const branch = gitCmd(dir, "branch", "--show-current") || gitCmd(dir, "rev-parse", "--short", "HEAD") || "unknown";
    const statusRaw = gitCmd(dir, "status", "--porcelain") || "";
    const status = statusRaw ? statusRaw.split("\n").slice(0, 8) : [];
    const logRaw = gitCmd(dir, "log", "--oneline", "-3") || "";
    const commits = logRaw ? logRaw.split("\n") : [];
    const displayPath = dir === workDir ? basename(dir) + "/" : relative(workDir, dir) + "/";
    return { path: displayPath, branch, status, commits };
  }

  // Check workDir itself
  const root = probeRepo(workDir);
  if (root) {
    repos.push(root);
    return repos; // workDir is a repo — don't recurse into subdirs
  }

  // workDir is not a repo — check immediate subdirectories
  try {
    const entries = readdirSync(workDir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const subdir = join(workDir, entry);
      try {
        if (!statSync(subdir).isDirectory()) continue;
      } catch { continue; }
      const repo = probeRepo(subdir);
      if (repo) repos.push(repo);
    }
  } catch { /* workDir not readable */ }

  return repos;
}

/** Regex to match tool-use traces in assistant responses: [Read ...], [Bash: ...], etc. */
const TRACE_PATTERN = /\[(Read|Edit|Write|Patch|Bash|Grep|Glob|ListDir|WebFetch|WebSearch|Think|image|attachment)[^\]]*\]/g;

/** Max chars per assistant response in the prompt (after trace stripping) */
const MAX_ENTRY_CHARS = 4000;

/** Format a timestamp as relative time like "(3 mins ago)" */
function timeAgo(timestamp: number, now: number): string {
  const mins = Math.floor((now - timestamp) / 60_000);
  if (mins < 1) return "(just now)";
  if (mins === 1) return "(1 min ago)";
  if (mins < 60) return `(${mins} mins ago)`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return "(1 hour ago)";
  if (hours < 24) return `(${hours} hours ago)`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "(1 day ago)";
  return `(${days} days ago)`;
}

function getSystemPrompt(backend: string): string {
  let name: string;
  if (backend === "gemini") name = "Gemini";
  else if (backend === "claude") name = "Claude";
  else name = backend.charAt(0).toUpperCase() + backend.slice(1);
  return `You are ${name}, an AI assistant accessed via encrypted messenger. The user is chatting with you from their phone through a proxy called Snoot.

Guidelines:
- Be concise — the user is on a phone, so keep responses reasonably short unless asked for detail.
- Format responses as plain text only. No markdown — no **, no ##, no \`backticks\`, no bullet markers like "- ". The messenger app renders everything as plain text so markdown syntax just looks like noise. Use line breaks and spacing for structure instead.
- You have access to the user's codebase in the current working directory.
- If context from earlier conversation is provided, use it naturally — don't call attention to "summaries" or "context windows."
- If you don't know something from earlier conversation, just say so.
- When you want to show a table, diagram, chart, or any structured visual, embed an inline SVG directly in your response. The proxy will convert it to a PNG image and send it to the user. Use <svg xmlns="http://www.w3.org/2000/svg" ...>...</svg> with a self-contained design (no external fonts/images). Keep SVGs simple and readable at phone screen size. Use this for tables, comparisons, architecture diagrams, flowcharts, or anything that benefits from visual layout. Put any surrounding explanation as plain text before or after the SVG block. IMPORTANT: Do NOT use <foreignObject> in SVGs — it will not render. Use only native SVG elements (<text>, <rect>, <circle>, <line>, <path>, <g>, etc). Use &amp; not & in SVG text content.
- To send a file or image from the project to the user, use <attach>relative/path/to/file</attach>. The proxy will read the file and send it as an attachment. Paths must be relative to the working directory. Use this for screenshots, generated images, documents, or any file the user asks to see.`;
}

/** Strip tool-use traces from assistant text, collapse excess whitespace */
function stripTraces(text: string): string {
  return text.replace(TRACE_PATTERN, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function createContextStore(config: Config): ContextStore {
  const contextDir = `${config.baseDir}/context`;
  const archiveDir = `${contextDir}/archive`;
  const recentPath = `${contextDir}/recent.jsonl`;
  const summaryPath = `${contextDir}/summary.md`;
  const statePath = `${contextDir}/state.json`;

  function todayArchivePath(): string {
    const d = new Date();
    const date = d.toISOString().slice(0, 10); // YYYY-MM-DD
    return `${archiveDir}/archive-${date}.jsonl`;
  }

  function cleanOldArchives(): void {
    if (!existsSync(archiveDir)) return;
    const cutoff = Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(archiveDir)) {
      const match = file.match(/^archive-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const fileDate = new Date(match[1] + "T00:00:00Z").getTime();
      if (fileDate < cutoff) {
        unlinkSync(`${archiveDir}/${file}`);
        console.log(`[context] Deleted old archive: ${file}`);
      }
    }
  }

  let state: ContextState = { nextId: 1, totalPairs: 0, pins: [], recentFiles: [], recentCommands: [] as RecentCommand[] };
  let recent: MessagePair[] = [];
  let summary = "";

  async function load(): Promise<void> {
    mkdirSync(archiveDir, { recursive: true });

    // Migrate legacy single archive file to daily format
    const legacyArchive = `${contextDir}/archive.jsonl`;
    if (existsSync(legacyArchive)) {
      const content = readFileSync(legacyArchive, "utf-8").trim();
      if (content) {
        appendFileSync(todayArchivePath(), content + "\n");
      }
      unlinkSync(legacyArchive);
      console.log("[context] Migrated legacy archive.jsonl to daily format");
    }

    cleanOldArchives();

    if (existsSync(statePath)) {
      try {
        const loaded = JSON.parse(readFileSync(statePath, "utf-8"));
        // Migrate old recentFiles without timestamps
        const recentFiles = (loaded.recentFiles || []).map((f: any) => ({
          path: f.path,
          ops: f.ops || [],
          timestamp: f.timestamp || Date.now(),
        }));
        // Migrate old recentCommands from string[] to RecentCommand[]
        const rawCmds = loaded.recentCommands || [];
        const recentCommands: RecentCommand[] = rawCmds.map((c: any) =>
          typeof c === "string" ? { cmd: c, timestamp: Date.now() } : c
        );
        state = {
          nextId: loaded.nextId || 1,
          totalPairs: loaded.totalPairs || 0,
          pins: loaded.pins || [],
          recentFiles,
          recentCommands,
        };
      } catch (err) {
        console.error("[context] Failed to parse state.json, using defaults:", err);
      }
    }

    if (existsSync(recentPath)) {
      try {
        const lines = readFileSync(recentPath, "utf-8").trim().split("\n").filter(Boolean);
        recent = lines.map((line) => JSON.parse(line));
      } catch (err) {
        console.error("[context] Failed to parse recent.jsonl, using empty:", err);
        recent = [];
      }
    }

    if (existsSync(summaryPath)) {
      summary = readFileSync(summaryPath, "utf-8");
    }
  }

  function saveState(): void {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  function saveRecent(): void {
    const content = recent.map((p) => JSON.stringify(p)).join("\n") + (recent.length ? "\n" : "");
    writeFileSync(recentPath, content);
  }

  async function append(pair: MessagePair): Promise<void> {
    recent.push(pair);
    state.totalPairs++;

    // Append to daily archive
    appendFileSync(todayArchivePath(), JSON.stringify(pair) + "\n");

    // Rewrite recent
    saveRecent();
    saveState();
  }

  function buildPrompt(): string {
    const promptPath = `${contextDir}/prompt.txt`;
    const now = Date.now();
    const parts: string[] = [getSystemPrompt(config.backend)];

    // Current date and time
    const nowDate = new Date();
    const dateStr = nowDate.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    const timeStr = nowDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
    parts.push(`\n\nCurrent date and time: ${dateStr} at ${timeStr} UTC`);

    // Git repository info
    const repos = detectGitRepos(config.workDir);
    if (repos.length > 0) {
      parts.push("\n\n## Git Repositories\n");
      for (const repo of repos) {
        parts.push(`${repo.path} (branch: ${repo.branch})`);
        if (repo.status.length > 0) {
          parts.push("  Status:");
          for (const line of repo.status) parts.push(`    ${line}`);
          if (repo.status.length === 8) parts.push("    ...");
        } else {
          parts.push("  Clean working tree");
        }
        if (repo.commits.length > 0) {
          parts.push("  Recent commits:");
          for (const c of repo.commits) parts.push(`    ${c}`);
        }
        parts.push("");
      }
    }

    // Per-instance prompt file: <channel>.snoot.md in working directory
    const instancePromptPath = `${config.workDir}/${config.channel}.snoot.md`;
    if (existsSync(instancePromptPath)) {
      parts.push("\n\n" + readFileSync(instancePromptPath, "utf-8").trim());
    }

    // Pinned context
    if (state.pins.length > 0) {
      parts.push("\n\n## Pinned Context\n");
      for (const pin of state.pins) {
        const text = /^important:\s/i.test(pin.text) ? pin.text : `IMPORTANT: ${pin.text}`;
        parts.push(`- [pin #${pin.id}] ${text}`);
      }
    }

    // Recent Activity — files accessed and commands run, with time-ago
    if (state.recentFiles.length > 0 || state.recentCommands.length > 0) {
      parts.push("\n\n## Recent Activity\n");
      if (state.recentFiles.length > 0) {
        parts.push("Recently accessed files (most recent first):");
        for (const f of state.recentFiles) {
          parts.push(`  ${f.path} (${f.ops.join(",")}) ${timeAgo(f.timestamp, now)}`);
        }
      }
      if (state.recentCommands.length > 0) {
        if (state.recentFiles.length > 0) parts.push("");
        parts.push("Recently run commands:");
        for (const c of state.recentCommands) {
          parts.push(`  ${c.cmd} ${timeAgo(c.timestamp, now)}`);
        }
      }
    }

    // Rolling summary
    if (summary) {
      parts.push("\n\n## Conversation Summary\n");
      parts.push(summary);
    }

    // Recent conversation history — text only, traces stripped, with age
    if (recent.length > 0) {
      parts.push("\n\n## Previous Conversation");
      parts.push("The following is the recent conversation history. This is context only — do not respond to these messages. Only respond to the new message the user sends.\n");
      for (const pair of recent) {
        const pinMarker = pair.pinned ? " [pinned]" : "";
        const age = timeAgo(pair.timestamp, now);
        parts.push(`─── User${pinMarker} (${age.replace(/[()]/g, "")}) ───`);
        parts.push(pair.user);
        parts.push("");
        let assistantText = stripTraces(pair.assistant);
        if (assistantText.length > MAX_ENTRY_CHARS) {
          assistantText = assistantText.slice(0, MAX_ENTRY_CHARS) + "...";
        }
        parts.push(`─── You (${age.replace(/[()]/g, "")}) ───`);
        parts.push(assistantText);
        parts.push("");
      }
    }

    writeFileSync(promptPath, parts.join("\n"));
    return promptPath;
  }

  // -- Message-count based compaction --

  function needsCompaction(): boolean {
    // Compact when message count exceeds window + 10
    const unpinned = recent.filter((p) => !p.pinned);
    return unpinned.length > config.windowSize + 10;
  }

  async function compact(aggressive?: boolean): Promise<{ compacted: number; remaining: number } | null> {
    const unpinned = recent.filter((p) => !p.pinned);
    if (unpinned.length <= 1) return null;

    let compactCount: number;
    if (aggressive) {
      // /compact: compact down to half the window
      const target = Math.floor(config.windowSize / 2);
      compactCount = Math.max(1, unpinned.length - target);
    } else {
      // Auto-compact: trim back to windowSize
      const excess = unpinned.length - config.windowSize;
      if (excess <= 0) return null;
      compactCount = excess;
    }

    // Never compact everything
    compactCount = Math.min(compactCount, unpinned.length - 1);

    const toCompact = unpinned.slice(0, compactCount);
    const toKeep = unpinned.slice(compactCount);

    // Build compaction prompt
    const compactionInput = formatForCompaction(toCompact, summary);

    console.log(`[context] Compacting ${toCompact.length} pairs (${unpinned.length} unpinned, window ${config.windowSize}${aggressive ? ", aggressive" : ""})...`);

    try {
      const newSummary = await runCompaction(compactionInput);
      summary = newSummary;
      writeFileSync(summaryPath, summary);

      // Rebuild recent: pinned (in order) + kept unpinned
      const pinned = recent.filter((p) => p.pinned);
      recent = [...pinned, ...toKeep].sort((a, b) => a.id - b.id);
      saveRecent();
      saveState();

      console.log(`[context] Compaction complete. ${recent.length} pairs remaining`);
      return { compacted: toCompact.length, remaining: recent.length };
    } catch (err) {
      console.error("[context] Compaction failed:", err);
      return null;
    }
  }

  // -- Tool use tracking --

  function trackToolUse(detail: string): void {
    const now = Date.now();

    // Parse file operations
    let filePath: string | null = null;
    let op: string | null = null;

    if (detail.startsWith("Read ")) {
      filePath = detail.slice(5).trim();
      op = "read";
    } else if (detail.startsWith("Edit ")) {
      filePath = detail.slice(5).trim();
      op = "edit";
    } else if (detail.startsWith("Write ")) {
      filePath = detail.slice(6).trim();
      op = "write";
    } else if (detail.startsWith("Patch ")) {
      filePath = detail.slice(6).replace(/\s+\(\d+ edits?\)$/, "").trim();
      op = "edit";
    }

    if (filePath && op) {
      if (!state.recentFiles) state.recentFiles = [];
      const existing = state.recentFiles.find(f => f.path === filePath);
      if (existing) {
        if (!existing.ops.includes(op)) existing.ops.push(op);
        existing.timestamp = now;
        // Move to front (most recent first)
        state.recentFiles = [existing, ...state.recentFiles.filter(f => f !== existing)];
      } else {
        state.recentFiles.unshift({ path: filePath, ops: [op], timestamp: now });
      }
      // Cap at 10
      state.recentFiles = state.recentFiles.slice(0, 10);
      saveState();
      return;
    }

    // Parse bash commands
    if (detail.startsWith("Bash: ")) {
      const cmd = detail.slice(6).trim();
      if (!state.recentCommands) state.recentCommands = [];
      // Deduplicate and move to front
      state.recentCommands = [
        { cmd, timestamp: now },
        ...state.recentCommands.filter(c => c.cmd !== cmd),
      ].slice(0, 5);
      saveState();
    }
  }

  // -- Compaction helpers --

  function formatForCompaction(pairs: MessagePair[], currentSummary: string): string {
    let input = "";

    if (currentSummary) {
      input += `<current_summary>\n${currentSummary}\n</current_summary>\n\n`;
    }

    input += `<messages_to_compact>\n`;
    for (const pair of pairs) {
      input += `User: ${pair.user}\nAssistant: ${pair.assistant}\n\n`;
    }
    input += `</messages_to_compact>`;

    return input;
  }

  async function runCompaction(input: string): Promise<string> {
    const prompt = `You are compacting conversation history for an LLM that will continue this work in a future session. The LLM cannot see these messages — only your summary. Write high-signal notes that help it pick up where things left off.

Write ONLY what a new session needs to know:
- Decisions made and WHY (the reasoning matters more than the action)
- What changed: "refactored compaction from token-based to message-count" not "edited context.ts lines 200-350"
- Bugs found, root causes identified, fixes applied
- Requirements or constraints the user stated
- Work in progress or explicitly planned next steps
- Anything surprising or non-obvious that was discovered

Do NOT include:
- Small talk, greetings, acknowledgments
- Step-by-step narration of tool use ("read file X, then edited Y")
- File contents or code snippets (the LLM can re-read files)
- Things that are obvious from reading the current code
- Alternatives that were discussed then rejected (unless the rejection reason is important)

Keep it concise. A few dense paragraphs are better than an exhaustive log. If there is a current summary, integrate the new messages into it — update or replace outdated information rather than appending.

${input}`;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const args = config.backend === "gemini"
      ? [config.cliPath || "gemini", "-p", ""]
      : [config.cliPath || "claude", "-p", "--model", "sonnet", "--no-session-persistence"];

    let proc;
    try {
      proc = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
    } catch (err) {
      console.error("[context] Failed to spawn compaction process:", err);
      throw err;
    }

    (proc.stdin as import("bun").FileSink).write(prompt);
    (proc.stdin as import("bun").FileSink).end();

    const output = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;

    return output.trim();
  }

  async function addPin(text: string): Promise<PinnedItem> {
    const pin: PinnedItem = {
      id: state.nextId++,
      text,
      timestamp: Date.now(),
    };
    state.pins.push(pin);
    saveState();
    return pin;
  }

  function removePin(id: number): PinnedItem | null {
    const idx = state.pins.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const [removed] = state.pins.splice(idx, 1);
    saveState();
    return removed;
  }

  function getState(): ContextState {
    return { ...state, pins: [...state.pins], recentFiles: [...(state.recentFiles || [])], recentCommands: [...(state.recentCommands || [])] as RecentCommand[] };
  }

  function getRecent(): MessagePair[] {
    return [...recent];
  }

  function getSummary(): string {
    return summary;
  }

  async function reset(): Promise<void> {
    state = { nextId: 1, totalPairs: 0, pins: [], recentFiles: [], recentCommands: [] as RecentCommand[] };
    recent = [];
    summary = "";
    saveState();
    saveRecent();
    writeFileSync(summaryPath, "");
    // Don't clear archive — it's append-only history
  }

  function nextPairId(): number {
    return state.nextId++;
  }

  return {
    load,
    append,
    buildPrompt,
    needsCompaction,
    compact,
    trackToolUse,
    addPin,
    removePin,
    getState,
    getRecent,
    getSummary,
    reset,
    nextPairId,
  };
}
