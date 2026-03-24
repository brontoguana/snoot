import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import type { Config, ContextStore, ContextState, MessagePair, PinnedItem } from "./types.js";

const ARCHIVE_RETENTION_DAYS = 30;

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
- When you want to show a table, diagram, chart, or any structured visual, embed an inline SVG directly in your response. The proxy will convert it to a PNG image and send it to the user. Use <svg xmlns="http://www.w3.org/2000/svg" ...>...</svg> with a self-contained design (no external fonts/images). Keep SVGs simple and readable at phone screen size. Use this for tables, comparisons, architecture diagrams, flowcharts, or anything that benefits from visual layout. Put any surrounding explanation as plain text before or after the SVG block.
- To send a file or image from the project to the user, use <attach>relative/path/to/file</attach>. The proxy will read the file and send it as an attachment. Paths must be relative to the working directory. Use this for screenshots, generated images, documents, or any file the user asks to see.`;
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

  let state: ContextState = { nextId: 1, totalPairs: 0, pins: [] };
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
        state = JSON.parse(readFileSync(statePath, "utf-8"));
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
    const parts: string[] = [getSystemPrompt(config.backend)];

    // Per-instance prompt file: <channel>.snoot.md in working directory
    const instancePromptPath = `${config.workDir}/${config.channel}.snoot.md`;
    if (existsSync(instancePromptPath)) {
      parts.push("\n\n" + readFileSync(instancePromptPath, "utf-8").trim());
    }

    // Pinned context
    if (state.pins.length > 0) {
      parts.push("\n\n## Pinned Context\n");
      for (const pin of state.pins) {
        parts.push(`- [pin #${pin.id}] ${pin.text}`);
      }
    }

    // Rolling summary
    if (summary) {
      parts.push("\n\n## Conversation Summary\n");
      parts.push(summary);
    }

    // Recent conversation history
    if (recent.length > 0) {
      parts.push("\n\n## Previous Conversation");
      parts.push("The following is the recent conversation history. This is context only — do not respond to these messages. Only respond to the new message the user sends.\n");
      for (const pair of recent) {
        const pinMarker = pair.pinned ? " [pinned]" : "";
        parts.push(`User${pinMarker}: ${pair.user}`);
        parts.push(`Assistant: ${pair.assistant}`);
        parts.push("");
      }
    }

    writeFileSync(promptPath, parts.join("\n"));
    return promptPath;
  }

  /** Estimate token count from character count (~4 chars per token) */
  function estimateTokens(chars: number): number {
    return Math.ceil(chars / 4);
  }

  /** Calculate total context tokens (summary + pins + recent pairs) */
  function currentContextTokens(): number {
    let chars = summary.length;
    for (const pin of state.pins) {
      chars += pin.text.length + 20; // overhead for pin formatting
    }
    for (const pair of recent) {
      chars += pair.user.length + pair.assistant.length + 30; // overhead for User:/Assistant: labels
    }
    return estimateTokens(chars);
  }

  /** History budget is half the total context budget — leaves the other half for
   *  system prompt, tool definitions, CLAUDE.md files, and the LLM's own working space. */
  function historyBudget(): number {
    return Math.floor(config.contextBudget / 2);
  }

  function needsCompaction(): boolean {
    // Compact when conversation history exceeds 125% of the history budget
    const threshold = historyBudget() * 1.25;
    return currentContextTokens() > threshold;
  }

  async function compact(): Promise<void> {
    const hBudget = historyBudget();
    const current = currentContextTokens();
    if (current <= hBudget) return;

    // Calculate how many tokens over the history budget we are
    const excess = current - hBudget;

    // Find the oldest unpinned pairs that account for ~the excess
    const unpinned = recent.filter((p) => !p.pinned);
    if (unpinned.length <= 1) return; // nothing to compact

    let accumulated = 0;
    let compactCount = 0;
    for (const pair of unpinned) {
      const pairTokens = estimateTokens(pair.user.length + pair.assistant.length);
      accumulated += pairTokens;
      compactCount++;
      if (accumulated >= excess) break;
    }

    // Always compact at least 1 pair
    compactCount = Math.max(1, compactCount);

    const toCompact = unpinned.slice(0, compactCount);
    const toKeep = unpinned.slice(compactCount);

    // Build compaction prompt
    const compactionInput = formatForCompaction(toCompact, summary);

    console.log(`[context] Compacting ${toCompact.length} pairs (~${accumulated} tokens excess of ${hBudget} history budget, ${config.contextBudget} total budget)...`);

    try {
      const newSummary = await runCompaction(compactionInput);
      summary = newSummary;
      writeFileSync(summaryPath, summary);

      // Rebuild recent: pinned (in order) + kept unpinned
      const pinned = recent.filter((p) => p.pinned);
      recent = [...pinned, ...toKeep].sort((a, b) => a.id - b.id);
      saveRecent();
      saveState();

      const newTokens = currentContextTokens();
      console.log(`[context] Compaction complete. ${recent.length} pairs, ~${newTokens} tokens`);
    } catch (err) {
      console.error("[context] Compaction failed:", err);
    }
  }

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
    const prompt = `Summarize this conversation history into a concise rolling summary. The conversation includes both text responses and tool-use traces (file reads, edits, bash commands, searches shown in [brackets]).

Preserve:
- All file paths read, edited, or created — and what was done to them
- Code changes: what was modified, added, or removed and why
- Bash commands run and their outcomes (especially errors)
- Decisions made and their reasoning
- Key technical facts, requirements, and constraints
- Any tasks in progress or planned

Discard:
- Pleasantries and small talk
- Redundant explanations
- Full file contents (summarize what was found instead)
- Rejected alternatives (unless the rejection reason is important)

If there is a current summary, integrate the new messages into it rather than starting fresh.

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

  async function removePin(id: number): Promise<boolean> {
    const idx = state.pins.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    state.pins.splice(idx, 1);
    saveState();
    return true;
  }

  function getState(): ContextState {
    return { ...state, pins: [...state.pins] };
  }

  function getRecent(): MessagePair[] {
    return [...recent];
  }

  function getSummary(): string {
    return summary;
  }

  async function reset(): Promise<void> {
    state = { nextId: 1, totalPairs: 0, pins: [] };
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
    addPin,
    removePin,
    getState,
    getRecent,
    getSummary,
    reset,
    nextPairId,
  };
}
