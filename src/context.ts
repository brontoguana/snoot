import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import type { Config, ContextStore, ContextState, MessagePair, PinnedItem } from "./types.js";

const ARCHIVE_RETENTION_DAYS = 30;

const SYSTEM_PROMPT = `You are Claude, an AI assistant accessed via Session encrypted messenger. The user is chatting with you from their phone through a proxy called Snoot.

Guidelines:
- Be concise — the user is on a phone, so keep responses reasonably short unless asked for detail.
- You have access to the user's codebase in the current working directory.
- If context from earlier conversation is provided, use it naturally — don't call attention to "summaries" or "context windows."
- If you don't know something from earlier conversation, just say so.`;

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
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    }

    if (existsSync(recentPath)) {
      const lines = readFileSync(recentPath, "utf-8").trim().split("\n").filter(Boolean);
      recent = lines.map((line) => JSON.parse(line));
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
    const parts: string[] = [SYSTEM_PROMPT];

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

  function needsCompaction(): boolean {
    return recent.length > config.compactAt;
  }

  async function compact(): Promise<void> {
    if (recent.length <= config.windowSize) return;

    // Separate pinned from unpinned
    const pinned = recent.filter((p) => p.pinned);
    const unpinned = recent.filter((p) => !p.pinned);

    // Calculate how many unpinned to remove
    const targetUnpinned = config.windowSize - pinned.length;
    if (targetUnpinned <= 0 || unpinned.length <= targetUnpinned) return;

    const toCompact = unpinned.slice(0, unpinned.length - targetUnpinned);
    const toKeep = unpinned.slice(unpinned.length - targetUnpinned);

    // Build compaction prompt
    const compactionInput = formatForCompaction(toCompact, summary);

    console.log(`[context] Compacting ${toCompact.length} pairs...`);

    try {
      const newSummary = await runCompaction(compactionInput);
      summary = newSummary;
      writeFileSync(summaryPath, summary);

      // Rebuild recent: pinned (in order) + kept unpinned
      recent = [...pinned, ...toKeep].sort((a, b) => a.id - b.id);
      saveRecent();
      saveState();

      console.log(`[context] Compaction complete. Window: ${recent.length} pairs`);
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
    const prompt = `Summarize this conversation history into a concise rolling summary. Preserve:
- All code snippets and file paths mentioned
- Decisions made and their reasoning
- Key technical facts and requirements
- Any tasks in progress or planned

Discard:
- Pleasantries and small talk
- Redundant explanations
- Rejected alternatives (unless the rejection reason is important)

If there is a current summary, integrate the new messages into it rather than starting fresh.

${input}`;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = Bun.spawn(
      ["claude", "-p", "--model", "haiku", "--no-session-persistence"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }
    );

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    const output = await new Response(proc.stdout).text();
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
