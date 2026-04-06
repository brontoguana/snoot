import { resolve, basename, dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync } from "fs";
import type { Config, LLMManager, LLMStatus, Mode } from "./types.js";
import { TOOLS_BY_MODE } from "./types.js";

const MAX_TURNS = 50;
const RATE_LIMIT_RETRY_DELAY = 30_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const API_ERROR_RETRY_DELAYS = [30_000, 60_000];
const API_REQUEST_TIMEOUT = 120_000;    // 120s timeout per API request
const MAX_API_RETRIES = 2;             // Retry up to 2 times on timeout/network errors
const MAX_TOOL_RESULT_CHARS = 30_000;   // Cap individual tool results
const DEFAULT_MAX_CONTEXT_CHARS = 400_000; // Start trimming old content above this
const TRIMMED_STUB = "[Content trimmed to save context — re-read the file if needed]";
const TRIMMED_ASSISTANT_STUB = "[Earlier analysis trimmed to save context]";

// Chrome's reduced/frozen UA string — Chrome committed to freezing this format,
// so it won't go stale. Sites check for "Chrome/" presence, not the exact version.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// -- Tool Definitions (OpenAI function calling format) --

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export function getToolDefinitions(mode: Mode): ToolDef[] {
  const tools: ToolDef[] = [];
  const allowed = TOOLS_BY_MODE[mode];
  if (!allowed) return tools;

  const names = allowed.split(",").map(s => s.trim());

  if (names.includes("Read")) {
    tools.push({
      type: "function",
      function: {
        name: "Read",
        description: "Read a file from the filesystem. Returns content with line numbers and a header showing the range and total line count (e.g. 'Lines 1-200 of 8432'). Use offset and limit to read specific sections of large files.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file to read" },
            offset: { type: "number", description: "Line number to start reading from (1-based)" },
            limit: { type: "number", description: "Max number of lines to read (default 2000)" },
          },
          required: ["file_path"],
        },
      },
    });
  }

  if (names.includes("Grep")) {
    tools.push({
      type: "function",
      function: {
        name: "Grep",
        description: "Search file contents using regex (powered by ripgrep). By default returns matching lines with file paths and line numbers. Set output_mode to 'files' to get just filenames (saves tokens for broad searches), or 'count' for match counts per file. Use context parameters (-A, -B, -C) to see surrounding code — avoids needing a separate Read call. Use glob or type to narrow the search. Set multiline=true to match patterns across line boundaries.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "File or directory to search in (default: working directory)" },
            glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts', '*.{js,jsx}')" },
            type: { type: "string", description: "File type filter (e.g. 'ts', 'py', 'rust', 'go')" },
            output_mode: { type: "string", description: "Output mode: 'content' (default, matching lines), 'files' (filenames only), 'count' (match counts per file)" },
            context: { type: "number", description: "Show N lines before AND after each match (like grep -C). Only for content mode." },
            before: { type: "number", description: "Show N lines before each match (like grep -B). Only for content mode." },
            after: { type: "number", description: "Show N lines after each match (like grep -A). Only for content mode." },
            max_count: { type: "number", description: "Max matches per file (default 100)" },
            head_limit: { type: "number", description: "Max total lines of output across all files (default 500). Use to prevent huge results from broad searches." },
            case_insensitive: { type: "boolean", description: "Case-insensitive search (default false)" },
            multiline: { type: "boolean", description: "Enable multiline matching — pattern can span multiple lines (default false)" },
          },
          required: ["pattern"],
        },
      },
    });
  }

  if (names.includes("Glob")) {
    tools.push({
      type: "function",
      function: {
        name: "Glob",
        description: "Find files matching a glob pattern. Returns file paths sorted by modification time (most recently changed first). Use this instead of Bash find/ls commands. Use '**/' prefix to search recursively (e.g. '**/*.ts' finds all TypeScript files in all subdirectories).",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.js', '**/test_*.py')" },
            path: { type: "string", description: "Directory to search in (default: working directory)" },
          },
          required: ["pattern"],
        },
      },
    });
  }

  if (names.includes("Edit")) {
    tools.push({
      type: "function",
      function: {
        name: "Edit",
        description: "Replace a specific string in a file. The old_string must match exactly (including whitespace and indentation) and must be unique in the file unless replace_all is true. If old_string is not unique, include more surrounding context to make it unique. Always Read the file first to see the exact content before editing.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            old_string: { type: "string", description: "The exact string to find and replace (must match file content exactly)" },
            new_string: { type: "string", description: "The replacement string" },
            replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
    });
  }

  if (names.includes("Write")) {
    tools.push({
      type: "function",
      function: {
        name: "Write",
        description: "Write content to a file, creating directories if needed. Overwrites existing files completely. Use Edit for modifying existing files (it only sends the diff). Use Write only for new files or complete rewrites.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            content: { type: "string", description: "The full content to write to the file" },
          },
          required: ["file_path", "content"],
        },
      },
    });
  }

  if (names.includes("Bash")) {
    tools.push({
      type: "function",
      function: {
        name: "Bash",
        description: "Execute a bash command and return its output (stdout + stderr combined). Use this for running builds, tests, git commands, and system operations. Do NOT use bash for tasks that have dedicated tools: use Read instead of cat/head/tail, Edit instead of sed/awk, Grep instead of grep/rg, Glob instead of find. For long-running commands (builds, tests), set background=true to avoid blocking — you'll get back a handle to check on it later with 'cat /tmp/bg_<id>.out'.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The bash command to execute" },
            timeout: { type: "number", description: "Timeout in milliseconds (default 120000, max 600000)" },
            background: { type: "boolean", description: "Run in background and return immediately with a result file path (default false)" },
          },
          required: ["command"],
        },
      },
    });
  }

  if (names.includes("WebFetch")) {
    tools.push({
      type: "function",
      function: {
        name: "WebFetch",
        description: "Fetch a URL and return its content as clean readable text. HTML pages are automatically converted to text (scripts, styles, nav, and boilerplate are stripped). Use this to read documentation, API references, blog posts, etc. Will not work for pages that require authentication. For search, use WebSearch instead. Use max_bytes to limit how much of the page to download (useful for very large pages).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to fetch (must be fully-formed, e.g. https://...)" },
            raw: { type: "boolean", description: "Return raw HTML instead of extracted text (default false)" },
            max_bytes: { type: "number", description: "Max bytes to download (default 500KB). Use smaller values for large pages you only need the beginning of." },
          },
          required: ["url"],
        },
      },
    });
  }

  if (names.includes("WebSearch") || names.includes("WebFetch")) {
    tools.push({
      type: "function",
      function: {
        name: "WebSearch",
        description: "Search the web using DuckDuckGo. Returns top results with titles, URLs, and snippets. Use this for finding documentation, looking up error messages, checking current library versions, etc. Use WebFetch to read a specific result page after finding it.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
            num_results: { type: "number", description: "Max results to return (default 10, max 20)" },
          },
          required: ["query"],
        },
      },
    });
  }

  // Think — available whenever tools are available (helps weaker models plan)
  if (names.length > 0) {
    tools.push({
      type: "function",
      function: {
        name: "Think",
        description: "Use this tool to think through a problem step by step before taking action. The input is not executed or processed — it just helps you reason. Use it before complex tasks, multi-step plans, or when you need to weigh options.",
        parameters: {
          type: "object",
          properties: {
            thought: { type: "string", description: "Your reasoning or plan" },
          },
          required: ["thought"],
        },
      },
    });
  }

  // ListDirectory — available alongside Read (research + coding)
  if (names.includes("Read")) {
    tools.push({
      type: "function",
      function: {
        name: "ListDirectory",
        description: "List files and directories at a given path. Returns names with type indicators (/ for directories) and file sizes. Shows hidden files (dotfiles). Set depth > 1 to recurse into subdirectories (max 5). Use Glob for finding specific files by pattern.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path to list (default: working directory)" },
            show_hidden: { type: "boolean", description: "Include hidden files/dirs starting with . (default true)" },
            depth: { type: "number", description: "Recursion depth (default 1, max 5). Depth 2 shows immediate children of subdirs too." },
          },
        },
      },
    });

    tools.push({
      type: "function",
      function: {
        name: "Stat",
        description: "Get file/directory info without reading content. Returns: exists, type (file/directory/symlink), size, line count (for text files), last modified time. Use this to check if a file exists and how big it is before deciding whether to Read it.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file or directory" },
          },
          required: ["path"],
        },
      },
    });
  }

  // Patch — available alongside Edit (coding only). Multi-edit in one call.
  if (names.includes("Edit")) {
    tools.push({
      type: "function",
      function: {
        name: "Patch",
        description: "Apply multiple edits to a single file in one call. More efficient than multiple Edit calls when making several changes to the same file. Edits are applied sequentially — each old_string must be unique in the file at the time it is applied. Later edits see the result of earlier edits.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            edits: {
              type: "array",
              description: "Array of edits to apply sequentially",
              items: {
                type: "object",
                properties: {
                  old_string: { type: "string", description: "The exact string to find (must match exactly)" },
                  new_string: { type: "string", description: "The replacement string" },
                },
                required: ["old_string", "new_string"],
              },
            },
          },
          required: ["file_path", "edits"],
        },
      },
    });
  }

  return tools;
}

// -- Tool Execution --

function shortPath(p: string): string {
  const dir = basename(dirname(p));
  const file = basename(p);
  return dir && dir !== "." ? `${dir}/${file}` : file;
}

function formatToolUse(name: string, args: any, pathFn: (p: string) => string = shortPath): string {
  switch (name) {
    case "Read": return `Read ${args?.file_path ? pathFn(args.file_path) : ""}`;
    case "Edit": return `Edit ${args?.file_path ? pathFn(args.file_path) : ""}`;
    case "Write": return `Write ${args?.file_path ? pathFn(args.file_path) : ""}`;
    case "Patch": return `Patch ${args?.file_path ? pathFn(args.file_path) : ""} (${args?.edits?.length || 0} edits)`;
    case "Bash": return `Bash: ${(args?.command || "").slice(0, 120)}`;
    case "Grep": return `Grep "${args?.pattern || ""}" in ${args?.path ? pathFn(args.path) : "."}`;
    case "Glob": return `Glob ${args?.pattern || ""}`;
    case "ListDirectory": return `ListDir ${args?.path ? pathFn(args.path) : "."}${args?.depth > 1 ? ` (depth ${args.depth})` : ""}`;
    case "Stat": return `Stat ${args?.path ? pathFn(args.path) : ""}`;
    case "WebFetch": return `WebFetch: ${(args?.url || "").slice(0, 100)}`;
    case "WebSearch": return `WebSearch: ${(args?.query || "").slice(0, 100)}`;
    case "Think": return `Think (${(args?.thought || "").slice(0, 60)}...)`;
    default: return name;
  }
}

export async function executeTool(name: string, args: any, workDir: string): Promise<string> {
  try {
    switch (name) {
      case "Read": return await toolRead(args, workDir);
      case "Edit": return await toolEdit(args, workDir);
      case "Write": return await toolWrite(args, workDir);
      case "Patch": return await toolPatch(args, workDir);
      case "Bash": return await toolBash(args, workDir);
      case "Grep": return await toolGrep(args, workDir);
      case "Glob": return await toolGlob(args, workDir);
      case "ListDirectory": return await toolListDir(args, workDir);
      case "Stat": return await toolStat(args, workDir);
      case "WebFetch": return await toolWebFetch(args);
      case "WebSearch": return await toolWebSearch(args);
      case "Think": return "OK";
      default: return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function toolRead(args: any, workDir: string): Promise<string> {
  const filePath = resolve(workDir, args.file_path);
  if (!existsSync(filePath)) return `Error: File not found: ${args.file_path}`;

  // Binary detection: read first 8KB and check for null bytes (skip even-offset nulls for UTF-16)
  const fd = Bun.file(filePath);
  const size = fd.size;
  const probe = Buffer.from(await fd.slice(0, 8192).arrayBuffer());
  if (hasBinaryBytes(probe)) {
    const ext = filePath.split(".").pop()?.toLowerCase() || "unknown";
    return `Error: Binary file (${ext}, ${formatSize(size)}) — use Bash to inspect binary files.`;
  }

  const start = Math.max(0, (args.offset || 1) - 1);
  const limit = args.limit || 2000;

  // For large files (>1MB), stream only the needed lines instead of loading everything
  if (size > 1_000_000) {
    return await toolReadStreaming(filePath, size, start, limit);
  }

  const content = readFileSync(filePath, "utf-8");
  const totalLines = countLines(content);
  const lines = content.split("\n");
  // Remove phantom empty element from trailing newline so lines.length matches totalLines
  if (lines.length > 1 && lines[lines.length - 1] === "" && content.endsWith("\n")) {
    lines.pop();
  }
  const end = Math.min(start + limit, totalLines);
  const selected = lines.slice(start, end);
  const header = `Lines ${start + 1}-${end} of ${totalLines} | ${formatSize(size)}`;
  const body = selected.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
  return `${header}\n${body}`;
}

/** Stream-read specific lines from a large file without loading it all into memory */
async function toolReadStreaming(filePath: string, size: number, start: number, limit: number): Promise<string> {
  const stream = Bun.file(filePath).stream();
  const decoder = new TextDecoder();
  let lineNum = 0;
  let totalLines = 0;
  let leftover = "";
  const selected: string[] = [];
  const end = start + limit;

  for await (const chunk of stream) {
    const text = leftover + decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    leftover = lines.pop() ?? "";

    for (const line of lines) {
      totalLines++;
      if (lineNum >= start && lineNum < end) {
        selected.push(`${lineNum + 1}\t${line}`);
      }
      lineNum++;
    }
  }
  // Handle last line (no trailing newline)
  if (leftover) {
    totalLines++;
    if (lineNum >= start && lineNum < end) {
      selected.push(`${lineNum + 1}\t${leftover}`);
    }
  }

  const shownEnd = Math.min(start + selected.length, totalLines);
  const header = `Lines ${start + 1}-${shownEnd} of ${totalLines} | ${formatSize(size)}`;
  return `${header}\n${selected.join("\n")}`;
}

async function toolEdit(args: any, workDir: string): Promise<string> {
  const filePath = resolve(workDir, args.file_path);
  if (!existsSync(filePath)) return `Error: File not found: ${args.file_path}`;
  let content = readFileSync(filePath, "utf-8");
  if (args.replace_all) {
    if (!content.includes(args.old_string)) return "Error: old_string not found in file";
    content = content.replaceAll(args.old_string, args.new_string);
  } else {
    const idx = content.indexOf(args.old_string);
    if (idx === -1) return "Error: old_string not found in file";
    if (content.indexOf(args.old_string, idx + args.old_string.length) !== -1) {
      return "Error: old_string is not unique in the file. Provide more context or use replace_all.";
    }
    content = content.slice(0, idx) + args.new_string + content.slice(idx + args.old_string.length);
  }
  writeFileSync(filePath, content);
  return "OK";
}

async function toolWrite(args: any, workDir: string): Promise<string> {
  const filePath = resolve(workDir, args.file_path);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, args.content);
  return "OK";
}

let bgJobCounter = 0;

async function toolBash(args: any, workDir: string): Promise<string> {
  const timeout = Math.min(args.timeout || 120_000, 600_000);

  if (args.background) {
    const jobId = ++bgJobCounter;
    const outFile = `/tmp/bg_${jobId}.out`;
    const statusFile = `/tmp/bg_${jobId}.status`;
    // Run in background: redirect output to file, write exit code to status file
    const wrappedCmd = `(${args.command}) > "${outFile}" 2>&1; echo $? > "${statusFile}"`;
    Bun.spawn(["bash", "-c", wrappedCmd], {
      cwd: workDir,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return `Background job #${jobId} started.\nOutput: cat ${outFile}\nStatus: cat ${statusFile} (file appears when command finishes)`;
  }

  const result = Bun.spawnSync(["bash", "-c", args.command], {
    cwd: workDir,
    timeout,
    env: process.env,
  });
  let output = "";
  if (result.stdout) output += result.stdout.toString();
  if (result.stderr) output += (output ? "\n" : "") + result.stderr.toString();
  if (result.exitCode !== 0 && result.exitCode !== null) {
    output += `\nExit code: ${result.exitCode}`;
  }
  if (output.length > 50_000) {
    output = output.slice(0, 50_000) + "\n... (truncated)";
  }
  return output || "(no output)";
}

async function toolGrep(args: any, workDir: string): Promise<string> {
  const maxCount = args.max_count || 100;
  const headLimit = args.head_limit || 500;
  const mode = args.output_mode || "content";
  const rgArgs = ["rg"];

  if (mode === "files") {
    rgArgs.push("--files-with-matches");
  } else if (mode === "count") {
    rgArgs.push("--count");
  } else {
    rgArgs.push("--no-heading", "-n", "--max-count", String(maxCount));
  }

  if (args.case_insensitive) rgArgs.push("-i");
  if (args.glob) rgArgs.push("--glob", args.glob);
  if (args.type) rgArgs.push("--type", args.type);
  if (args.multiline) rgArgs.push("-U", "--multiline-dotall");

  // Context lines only for content mode
  if (mode === "content") {
    if (args.context) {
      rgArgs.push("-C", String(args.context));
    } else {
      if (args.before) rgArgs.push("-B", String(args.before));
      if (args.after) rgArgs.push("-A", String(args.after));
    }
  }

  rgArgs.push(args.pattern);
  if (args.path) rgArgs.push(args.path);

  const result = Bun.spawnSync(rgArgs, { cwd: workDir, timeout: 30_000 });
  let output = result.stdout?.toString() || "";

  // Apply head_limit: cap total output lines
  if (output) {
    const lines = output.split("\n");
    if (lines.length > headLimit) {
      output = lines.slice(0, headLimit).join("\n") + `\n\n⚠️ [Output capped at ${headLimit} lines — ${lines.length - headLimit} more lines omitted. Use head_limit to adjust, or narrow with glob/type/path.]`;
    }
  }

  return output || "(no matches)";
}

async function toolGlob(args: any, workDir: string): Promise<string> {
  const glob = new Bun.Glob(args.pattern);
  const dir = args.path ? resolve(workDir, args.path) : workDir;
  const files: Array<{ path: string; mtime: number }> = [];
  const MAX_SCAN = 10_000; // scan up to 10K files so mtime sort is accurate
  for await (const file of glob.scan({ cwd: dir })) {
    try {
      const st = statSync(join(dir, file));
      files.push({ path: file, mtime: st.mtimeMs });
    } catch {
      files.push({ path: file, mtime: 0 });
    }
    if (files.length >= MAX_SCAN) break;
  }
  // Sort by modification time, most recent first
  files.sort((a, b) => b.mtime - a.mtime);
  const display = files.slice(0, 200);
  const result = display.map(f => f.path).join("\n");
  if (files.length > 200) {
    const note = files.length >= MAX_SCAN ? `${MAX_SCAN}+` : String(files.length);
    return result + `\n... (showing 200 of ${note} matches, sorted by modification time)`;
  }
  return result || "(no matches)";
}

export function formatSize(size: number): string {
  return size < 1024 ? `${size}B`
    : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)}K`
    : `${(size / (1024 * 1024)).toFixed(1)}M`;
}

/** Count lines in text content, properly handling trailing newlines */
export function countLines(content: string): number {
  if (!content) return 0;
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  // If file ends with \n, the newline count IS the line count
  // If file doesn't end with \n, add 1 for the last unterminated line
  return content.charCodeAt(content.length - 1) === 10 ? count : count + 1;
}

/**
 * Detect binary content. Checks for null bytes but allows UTF-16 BOM files
 * (which have nulls at regular even/odd positions) to pass as text.
 */
export function hasBinaryBytes(buf: Buffer): boolean {
  // UTF-16 LE BOM: FF FE, UTF-16 BE BOM: FE FF — treat as text
  if (buf.length >= 2) {
    if ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF)) {
      return false;
    }
  }
  // Check for null bytes (classic binary indicator)
  return buf.includes(0);
}

async function toolListDir(args: any, workDir: string): Promise<string> {
  const dirPath = args.path ? resolve(workDir, args.path) : workDir;
  if (!existsSync(dirPath)) return `Error: Directory not found: ${args.path || "."}`;

  const showHidden = args.show_hidden !== false; // default true
  const maxDepth = Math.min(Math.max(args.depth || 1, 1), 5);
  const lines: string[] = [];

  function listRecursive(dir: string, prefix: string, depth: number, ancestorInodes: Set<number>): void {
    if (lines.length >= 500) return;

    // Check for symlink loops by tracking ancestor directory inodes (not globally)
    // This correctly allows two symlinks to the same target while catching actual loops
    try {
      const dirStat = statSync(dir);
      if (ancestorInodes.has(dirStat.ino)) {
        lines.push(`${prefix}(symlink loop detected, skipping)`);
        return;
      }
      ancestorInodes = new Set(ancestorInodes); // copy so siblings don't interfere
      ancestorInodes.add(dirStat.ino);
    } catch { return; }

    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      lines.push(`${prefix}(unreadable)`);
      return;
    }

    for (const entry of entries) {
      if (lines.length >= 500) { lines.push("... (truncated at 500 entries)"); return; }
      if (!showHidden && entry.startsWith(".")) continue;

      try {
        const fullPath = join(dir, entry);
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          lines.push(`${prefix}${entry}/`);
          if (depth < maxDepth) {
            listRecursive(fullPath, prefix + "  ", depth + 1, ancestorInodes);
          }
        } else {
          lines.push(`${prefix}${entry}  (${formatSize(st.size)})`);
        }
      } catch {
        lines.push(`${prefix}${entry}  (unreadable)`);
      }
    }
  }

  listRecursive(dirPath, "", 1, new Set());
  return lines.join("\n") || "(empty directory)";
}

async function toolStat(args: any, workDir: string): Promise<string> {
  const filePath = resolve(workDir, args.path);
  if (!existsSync(filePath)) return `Path: ${args.path}\nExists: false`;

  try {
    const lst = lstatSync(filePath);
    const st = lst.isSymbolicLink() ? statSync(filePath) : lst;
    const type = lst.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "file";
    const modified = new Date(st.mtimeMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    const info: string[] = [
      `Path: ${args.path}`,
      `Exists: true`,
      `Type: ${type}`,
      `Size: ${formatSize(st.size)} (${st.size} bytes)`,
      `Modified: ${modified}`,
    ];
    // For text files, count lines by streaming chunks (avoids loading entire file into memory)
    if (type === "file" && st.size < 10_000_000 && st.size > 0) {
      try {
        const fd = Bun.file(filePath);
        const stream = fd.stream();
        let lineCount = 0;
        let lastByte = 0;
        let isBinary = false;
        for await (const chunk of stream) {
          const buf = Buffer.from(chunk);
          if (hasBinaryBytes(buf)) { isBinary = true; break; }
          for (let i = 0; i < buf.length; i++) {
            if (buf[i] === 0x0a) lineCount++;
          }
          if (buf.length > 0) lastByte = buf[buf.length - 1];
        }
        if (isBinary) {
          info.push(`Binary: true`);
        } else {
          // If file ends with \n, lineCount is correct (each \n terminates a line)
          // If file doesn't end with \n, add 1 for the unterminated last line
          const total = lastByte === 0x0a ? lineCount : lineCount + 1;
          info.push(`Lines: ${total}`);
        }
      } catch {}
    }
    return info.join("\n");
  } catch (err) {
    return `Path: ${args.path}\nError: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function toolPatch(args: any, workDir: string): Promise<string> {
  const filePath = resolve(workDir, args.file_path);
  if (!existsSync(filePath)) return `Error: File not found: ${args.file_path}`;
  if (!Array.isArray(args.edits) || args.edits.length === 0) return "Error: edits array is empty";

  // Atomic: apply all edits to a copy first. Only write to disk if ALL succeed.
  const original = readFileSync(filePath, "utf-8");
  let content = original;
  const results: string[] = [];
  let hasError = false;

  for (let i = 0; i < args.edits.length; i++) {
    const edit = args.edits[i];
    if (!edit.old_string || edit.new_string === undefined) {
      results.push(`Edit ${i + 1}: Error — missing old_string or new_string`);
      hasError = true;
      break; // stop on first error
    }
    const idx = content.indexOf(edit.old_string);
    if (idx === -1) {
      results.push(`Edit ${i + 1}: Error — old_string not found`);
      hasError = true;
      break;
    }
    if (content.indexOf(edit.old_string, idx + edit.old_string.length) !== -1) {
      results.push(`Edit ${i + 1}: Error — old_string is not unique`);
      hasError = true;
      break;
    }
    content = content.slice(0, idx) + edit.new_string + content.slice(idx + edit.old_string.length);
    results.push(`Edit ${i + 1}: OK`);
  }

  if (hasError) {
    // No file written — all-or-nothing
    results.push(`\nPatch ABORTED — no changes written to disk. Fix the failing edit and retry.`);
    return results.join("\n");
  }

  writeFileSync(filePath, content);
  return results.join("\n");
}

async function toolWebFetch(args: any): Promise<string> {
  const maxBytes = Math.min(args.max_bytes || 500_000, 2_000_000); // cap at 2MB regardless
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(args.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // Stream-read with byte cap to avoid downloading huge pages into memory
    const reader = resp.body!.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let wasTruncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        // Keep only what fits
        const excess = totalBytes - maxBytes;
        chunks.push(value.slice(0, value.length - excess));
        wasTruncated = true;
        reader.cancel();
        break;
      }
      chunks.push(value);
    }
    const decoder = new TextDecoder();
    let text = chunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();

    const contentType = resp.headers.get("content-type") || "";

    // Convert HTML to readable text unless raw mode requested
    if (!args.raw && (contentType.includes("text/html") || contentType.includes("xhtml") || text.trimStart().startsWith("<"))) {
      text = htmlToText(text);
    }

    // Apply text-level cap (HTML→text conversion may shrink content substantially)
    const textCap = 50_000;
    if (text.length > textCap) {
      text = text.slice(0, textCap) + `\n... (truncated to ${textCap} chars — use max_bytes for finer control)`;
    } else if (wasTruncated) {
      text += `\n... (download capped at ${(maxBytes / 1024).toFixed(0)}KB — use max_bytes to adjust)`;
    }
    return text || "(empty response)";
  } finally {
    clearTimeout(timeout);
  }
}

/** Convert HTML to clean readable text, stripping boilerplate */
export function htmlToText(html: string): string {
  // Remove entire blocks that are noise
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Convert structural elements to line breaks
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|aside|blockquote|figure|figcaption|details|summary)\b[^>]*>/gi, "\n")
    .replace(/<\/?(h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<\/?li\b[^>]*>/gi, "\n")
    .replace(/<\/?tr\b[^>]*>/gi, "\n")
    .replace(/<\/?td\b[^>]*>/gi, "\t")
    .replace(/<\/?th\b[^>]*>/gi, "\t")
    .replace(/<\/?(ul|ol|table|thead|tbody|tfoot)\b[^>]*>/gi, "\n");

  // Convert links: <a href="url">text</a> → text (url)
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const linkText = inner.replace(/<[^>]*>/g, "").trim();
    const cleanHref = href.startsWith("/") || href.startsWith("http") ? href : "";
    return cleanHref && cleanHref !== linkText ? `${linkText} (${cleanHref})` : linkText;
  });

  // Convert code blocks
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    return "\n```\n" + inner.replace(/<[^>]*>/g, "") + "\n```\n";
  });
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => {
    return "`" + inner.replace(/<[^>]*>/g, "") + "`";
  });

  // Strip all remaining tags
  text = text.replace(/<[^>]*>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

  // Clean up whitespace: collapse blank lines, trim trailing spaces
  text = text
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

async function toolWebSearch(args: any): Promise<string> {
  const query = (args.query || "").trim();
  if (!query) return "Error: empty search query";
  const maxResults = Math.min(args.num_results || 10, 20);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await resp.text();
    return parseDDGResults(html, maxResults);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseDDGResults(html: string, maxResults: number): string {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Extract result blocks — each contains a result__a link and a result__snippet
  // DuckDuckGo HTML format:
  //   <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_URL&...">Title</a>
  //   <a class="result__snippet" href="...">Snippet text</a>

  // Match result__a links
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    const title = stripHtml(match[2]).trim();

    // Decode DuckDuckGo redirect URL
    const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      href = decodeURIComponent(uddgMatch[1]);
    } else if (href.startsWith("//")) {
      href = "https:" + href;
    }

    if (title && href && !href.includes("duckduckgo.com")) {
      links.push({ url: href, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]).trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || "",
    });
  }

  if (results.length === 0) return "(no results found)";

  return results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`
  ).join("\n\n");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")     // strip tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");       // collapse whitespace
}

// -- Fetch with timeout and retry --

/**
 * Shared fetch wrapper with per-request timeout and retry on timeout/network errors.
 * Used by both the agent loop's apiRequest and compaction.
 * @param url - The URL to fetch
 * @param init - Fetch init options (headers, body, etc.)
 * @param opts.signal - Optional external abort signal (e.g. from /stop)
 * @param opts.label - Label for logging
 * @param opts.timeoutMs - Per-request timeout (default 120s)
 * @param opts.maxRetries - Max retries on timeout/network error (default 2)
 * @returns The fetch Response
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; label?: string; timeoutMs?: number; maxRetries?: number } = {},
): Promise<Response> {
  const { signal, label = "api", timeoutMs = API_REQUEST_TIMEOUT, maxRetries = MAX_API_RETRIES } = opts;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // Create a per-request timeout that also respects the external signal
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);

    // If external signal fires, abort our timeout controller too
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const response = await fetch(url, { ...init, signal: timeoutController.signal });
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
      return response;
    } catch (err: any) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);

      // If the external signal aborted, don't retry
      if (signal?.aborted) throw err;

      // Classify error: timeout vs network vs other
      const isTimeout = err.name === "AbortError" || err.name === "TimeoutError" ||
        err.message?.includes("timed out") || err.message?.includes("timeout");
      const isNetwork = err.code === "ECONNRESET" || err.code === "ECONNREFUSED" ||
        err.code === "ETIMEDOUT" || err.code === "EPIPE" || err.message?.includes("fetch failed");

      if ((isTimeout || isNetwork) && attempt < maxRetries) {
        const waitSec = 5 * (attempt + 1); // 5s, 10s
        console.log(`[${label}] Request ${isTimeout ? "timed out" : "failed"} (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${waitSec}s`);
        lastError = err;
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }

      // Not retryable or out of retries
      if (lastError && (isTimeout || isNetwork)) {
        throw new Error(`Request failed after ${attempt + 1} attempts: ${err.message}`);
      }
      throw err;
    }
  }

  throw lastError || new Error("fetchWithRetry exhausted retries");
}

// -- Streaming SSE parser --

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface TurnResult {
  content: string;
  toolCalls: ToolCallAccumulator[];
  finishReason: string | null;
}

async function processStreamingResponse(
  response: Response,
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<TurnResult> {
  const result: TurnResult = { content: "", toolCalls: [], finishReason: null };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          result.content += delta.content;
          onChunk(delta.content);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            while (result.toolCalls.length <= idx) {
              result.toolCalls.push({ id: "", name: "", arguments: "" });
            }
            if (tc.id) result.toolCalls[idx].id = tc.id;
            if (tc.function?.name) result.toolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) result.toolCalls[idx].arguments += tc.function.arguments;
          }
        }

        if (choice.finish_reason) {
          result.finishReason = choice.finish_reason;
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) throw err;
  }

  return result;
}

/** Parse a non-streaming JSON response (fallback for servers that ignore stream:true) */
function parseNonStreamingResponse(json: any): TurnResult {
  const result: TurnResult = { content: "", toolCalls: [], finishReason: null };
  const choice = json.choices?.[0];
  if (!choice) return result;

  const msg = choice.message;
  if (msg?.content) result.content = msg.content;
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      result.toolCalls.push({
        id: tc.id || "",
        name: tc.function?.name || "",
        arguments: tc.function?.arguments || "{}",
      });
    }
  }
  result.finishReason = choice.finish_reason || null;
  return result;
}

// -- OpenAI LLM Manager --

export function createOpenAIManager(config: Config): LLMManager {
  let alive = false;
  let spawnedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let abortController: AbortController | null = null;

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

  const ep = config.endpointConfig!;
  const baseUrl = (ep.url || "").replace(/\/$/, "");
  const model = config.model || ep.model || "default";
  const apiKey = ep.apiKey || "";
  const label = config.backend;
  const maxContextChars = ep.maxContextChars || DEFAULT_MAX_CONTEXT_CHARS;

  function emitActivity(line: string): void {
    for (const cb of activityCallbacks) cb(line);
  }

  function emitChunk(text: string): void {
    for (const cb of chunkCallbacks) cb(text);
  }

  async function apiRequest(
    messages: any[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): Promise<TurnResult> {
    const body: any = { model, messages, stream: true, max_tokens: 24576 };
    if (tools.length > 0) body.tools = tools;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    // Create a request-scoped abort controller for stream stall timeout.
    // This lets us kill a stalled stream without aborting the entire agent loop.
    const requestController = new AbortController();
    const onExternalAbort = () => requestController.abort();
    signal.addEventListener("abort", onExternalAbort, { once: true });

    // Stream stall timer — resets on each chunk. If no data for 120s, abort.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.log(`[${label}] Stream stalled (no data for ${API_REQUEST_TIMEOUT / 1000}s) — aborting request`);
        requestController.abort();
      }, API_REQUEST_TIMEOUT);
    };
    const clearStallTimer = () => { if (stallTimer) clearTimeout(stallTimer); };

    try {
      // Start the stall timer — covers the initial fetch + response start
      resetStallTimer();

      const response = await fetchWithRetry(
        `${baseUrl}/chat/completions`,
        { method: "POST", headers, body: JSON.stringify(body) },
        { signal: requestController.signal, label },
      );

      if (!response.ok) {
        clearStallTimer();
        const errorText = await response.text().catch(() => "");
        const err = new Error(`${response.status}: ${errorText.slice(0, 500)}`);
        (err as any).status = response.status;
        throw err;
      }

      // Detect response format: SSE vs plain JSON
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        clearStallTimer();
        const json = await response.json();
        const result = parseNonStreamingResponse(json);
        if (result.content) emitChunk(result.content);
        return result;
      }

      // For streaming: reset stall timer on each chunk so active streams aren't killed.
      // Only truly stalled streams (no data for 120s) will timeout.
      const wrappedChunk = (text: string) => {
        resetStallTimer();
        emitChunk(text);
      };

      const result = await processStreamingResponse(response, wrappedChunk, requestController.signal);
      clearStallTimer();
      return result;
    } catch (err: any) {
      clearStallTimer();
      signal.removeEventListener("abort", onExternalAbort);
      // If our request-scoped controller aborted (stall timeout) but the external
      // signal is still alive, convert to a retriable timeout error
      if (requestController.signal.aborted && !signal.aborted) {
        const timeoutErr = new Error(`Request timed out (no data for ${API_REQUEST_TIMEOUT / 1000}s)`);
        (timeoutErr as any).isTimeout = true;
        throw timeoutErr;
      }
      throw err;
    } finally {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /** Estimate total character count of all messages (content + tool call args) */
  function estimateContextSize(messages: any[]): number {
    let total = 0;
    for (const m of messages) {
      if (typeof m.content === "string") {
        total += m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === "string") total += part.length;
          else if (part?.text) total += part.text.length;
        }
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += (tc.function?.arguments?.length || 0);
          total += (tc.function?.name?.length || 0);
        }
      }
    }
    // Account for tool definitions overhead (~500 chars per tool definition on average)
    const toolCount = (TOOLS_BY_MODE[config.mode] || "").split(",").filter(Boolean).length;
    total += toolCount * 500;
    return total;
  }

  /**
   * Trim old tool results AND long assistant responses to keep context within budget.
   * Preserves the most recent turn (so the model sees what it just did).
   */
  function trimOldContent(messages: any[]): void {
    const size = estimateContextSize(messages);
    if (size <= maxContextChars) return;

    // Find the last assistant message index — don't trim anything after it
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") { lastAssistantIdx = i; break; }
    }

    let trimmed = 0;
    for (let i = 0; i < messages.length && i < lastAssistantIdx; i++) {
      const m = messages[i];
      // Trim old tool results
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > 200) {
        trimmed += m.content.length - TRIMMED_STUB.length;
        m.content = TRIMMED_STUB;
      }
      // Trim long assistant responses (keep first 200 chars as summary hint)
      if (m.role === "assistant" && typeof m.content === "string" && m.content.length > 1000) {
        const preview = m.content.slice(0, 200);
        trimmed += m.content.length - preview.length - TRIMMED_ASSISTANT_STUB.length - 1;
        m.content = preview + "\n" + TRIMMED_ASSISTANT_STUB;
      }
    }
    if (trimmed > 0) {
      console.log(`[${label}] Trimmed ${(trimmed / 1024).toFixed(0)}KB from old content to stay within context budget (limit: ${(maxContextChars / 1024).toFixed(0)}KB)`);
    }
  }

  async function runAgentLoop(text: string, promptFile?: string): Promise<string> {
    let systemPrompt = "";
    if (promptFile) {
      try { systemPrompt = readFileSync(promptFile, "utf-8"); } catch {}
    }

    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: text });

    const tools = getToolDefinitions(config.mode);
    const signal = abortController!.signal;
    let accumulatedText = "";
    let turns = 0;
    let rateLimitRetried = false;
    let timeoutRetries = 0;

    while (turns < MAX_TURNS) {
      turns++;
      lastActivityAt = Date.now();

      if (signal.aborted) return accumulatedText || "[Request cancelled]";

      // Proactively trim old tool results if context is getting large
      trimOldContent(messages);

      let result: TurnResult;
      try {
        result = await apiRequest(messages, tools, signal);
        timeoutRetries = 0; // Reset on success
      } catch (err: any) {
        if (signal.aborted) return accumulatedText || "[Request cancelled]";

        // Handle stream stall timeouts — retry up to MAX_API_RETRIES times
        if (err.isTimeout && timeoutRetries < MAX_API_RETRIES) {
          timeoutRetries++;
          console.log(`[${label}] Stream timeout — retry ${timeoutRetries}/${MAX_API_RETRIES}`);
          emitActivity(`⏳ Request timed out, retrying (${timeoutRetries}/${MAX_API_RETRIES})...`);
          // Need a fresh abort controller since the old request-scoped one was aborted
          continue; // retry the turn
        }
        if (err.isTimeout) {
          return accumulatedText || `[Request timed out after ${MAX_API_RETRIES + 1} attempts]`;
        }

        const status = err?.status as number | undefined;
        if (status === 429) {
          if (!rateLimitRetried) {
            // Parse retry-after header if the API sent it, otherwise default to 30s
            const retryAfterMatch = err.message?.match(/retry.after[:\s]*(\d+)/i);
            const waitMs = retryAfterMatch ? parseInt(retryAfterMatch[1]) * 1000 : RATE_LIMIT_RETRY_DELAY;
            const waitSec = Math.ceil(waitMs / 1000);
            console.log(`[${label}] Rate limited — waiting ${waitSec}s before retry`);
            emitActivity(`⏳ Rate limited, retrying in ${waitSec}s...`);
            for (const cb of rateLimitCallbacks) cb(waitMs, 1);
            rateLimitRetried = true;
            await new Promise(r => setTimeout(r, waitMs));
            if (signal.aborted) return accumulatedText || "[Request cancelled]";
            continue; // retry the turn
          }
          // Already retried once — give up
          return accumulatedText || `[Rate limited: ${err.message}]`;
        }
        if (status && status >= 500) {
          return accumulatedText || `[API Error: ${err.message}]`;
        }
        if (status === 400) {
          // 400 usually means context too long after many tool calls.
          // Try aggressive trimming first, then retry once.
          const hasToolResults = messages.some(m => m.role === "tool" && m.content !== TRIMMED_STUB);
          if (hasToolResults) {
            console.log(`[${label}] Got 400 (likely context limit) — aggressively trimming all old tool results and retrying`);
            for (const m of messages) {
              if (m.role === "tool" && typeof m.content === "string" && m.content !== TRIMMED_STUB) {
                m.content = TRIMMED_STUB;
              }
            }
            continue; // retry the loop with trimmed context
          }
          // Already trimmed everything — give up
          const hint = err.message?.includes("validation") ? " (context/token limit — even after trimming)" : "";
          return accumulatedText || `[API Error${hint}: ${err.message}]`;
        }
        throw err;
      }

      accumulatedText += result.content;
      lastActivityAt = Date.now();

      // Log finish_reason for diagnostics
      if (result.finishReason) {
        console.log(`[${label}] Turn ${turns}/${MAX_TURNS} finish_reason: ${result.finishReason}, toolCalls: ${result.toolCalls.length}, text: ${result.content.length} chars`);
      }

      // If finish_reason is "length" but we got tool calls, they may be truncated/incomplete
      if (result.finishReason === "length" && result.toolCalls.length > 0) {
        console.error(`[${label}] WARNING: tool-calling turn truncated by token limit — tool calls may be incomplete`);
      }

      // If there are tool calls, execute them and loop
      if (result.toolCalls.length > 0) {
        const assistantMsg: any = {
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map(tc => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
        messages.push(assistantMsg);

        for (const tc of result.toolCalls) {
          let args: any;
          try {
            args = JSON.parse(tc.arguments);
          } catch {
            args = {};
            console.error(`[${label}] Failed to parse tool args for ${tc.name}: ${tc.arguments.slice(0, 200)}`);
          }

          const detail = formatToolUse(tc.name, args);
          const trackingDetail = formatToolUse(tc.name, args, p => p);
          console.log(`[${label}] Tool use: ${detail}`);
          emitActivity(`🔧 ${detail}`);
          for (const cb of toolUseCallbacks) cb(trackingDetail);

          let toolResult = await executeTool(tc.name, args, config.workDir);
          lastActivityAt = Date.now();

          // Cap individual tool results to prevent a single Read from blowing out context
          if (toolResult.length > MAX_TOOL_RESULT_CHARS) {
            console.log(`[${label}] Capping ${tc.name} result from ${(toolResult.length / 1024).toFixed(0)}KB to ${(MAX_TOOL_RESULT_CHARS / 1024).toFixed(0)}KB`);
            // Truncate at line boundary instead of mid-line
            let cutAt = toolResult.lastIndexOf("\n", MAX_TOOL_RESULT_CHARS);
            if (cutAt < MAX_TOOL_RESULT_CHARS * 0.5) cutAt = MAX_TOOL_RESULT_CHARS; // fallback if lines are very long
            const totalLines = toolResult.split("\n").length;
            const shownLines = toolResult.slice(0, cutAt).split("\n").length;
            // Tool-specific truncation hints
            let hint: string;
            switch (tc.name) {
              case "Read": hint = "Use offset/limit to read specific sections."; break;
              case "Grep": hint = "Use output_mode='files' for just filenames, or narrow with glob/type/path. Use head_limit to cap total output."; break;
              case "Bash": hint = "Pipe through head/tail or redirect to a file if you need the full output."; break;
              case "ListDirectory": hint = "Reduce depth or target a more specific subdirectory."; break;
              case "WebFetch": hint = "The page is very large. Try searching for specific content instead."; break;
              default: hint = "Consider a more targeted query to reduce output size."; break;
            }
            toolResult = toolResult.slice(0, cutAt) + `\n\n⚠️ [Output truncated — showing ~${shownLines} of ${totalLines} lines (${(cutAt / 1024).toFixed(0)}KB of ${(toolResult.length / 1024).toFixed(0)}KB). ${hint}]`;
          }

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: toolResult,
          });
        }

        continue;
      }

      // No tool calls but finish_reason is "length" — model wanted to call tools but got truncated
      if (result.finishReason === "length" && !result.content.trim()) {
        console.error(`[${label}] Empty response with finish_reason=length — likely truncated tool call, retrying turn`);
        // Push a system message asking the model to continue with shorter output
        messages.push({ role: "assistant", content: result.content || "" });
        messages.push({ role: "user", content: "Your previous response was truncated. Please continue — try to use fewer tool calls per turn if needed." });
        continue;
      }

      // No tool calls — final response
      if (result.finishReason === "length") {
        accumulatedText += "\n\n⚠️ Response was truncated (hit output token limit). You may want to ask me to continue, or switch to a model with higher output capacity.";
      }
      return accumulatedText;
    }

    return accumulatedText || `[Reached maximum of ${MAX_TURNS} tool-calling turns]`;
  }

  function send(text: string, promptFile?: string): void {
    if (alive) {
      console.error(`[${label}] WARNING: send() called while already running — aborting old request`);
      if (abortController) abortController.abort();
    }

    alive = true;
    spawnedAt = Date.now();
    lastActivityAt = Date.now();
    abortController = new AbortController();

    console.log(`[${label}] Starting agent loop (model: ${model}, endpoint: ${baseUrl})`);
    emitActivity(`⚡ ${label} started (model: ${model})`);

    runAgentLoop(text, promptFile)
      .then((result) => {
        alive = false;
        console.log(`[${label}] Agent loop complete (${result.length} chars, resolvers: ${responseResolvers.length})`);
        emitActivity(`✅ Done (${result.length} chars)`);

        const pending = responseResolvers;
        responseResolvers = [];
        for (const { resolve } of pending) resolve(result);
        for (const cb of exitCallbacks) cb();
      })
      .catch((err) => {
        alive = false;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${label}] Agent loop error:`, err);
        emitActivity(`❌ Error: ${msg}`);

        const pending = responseResolvers;
        responseResolvers = [];
        for (const { resolve } of pending) resolve(`[Error: ${msg}]`);
        for (const cb of exitCallbacks) cb();
      });
  }

  function waitForResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      responseResolvers.push({ resolve, reject });
    });
  }

  function isAlive(): boolean { return alive; }
  function isPendingRetry(): boolean { return false; }
  function cancelRetry(): void {}

  async function kill(): Promise<void> {
    if (abortController) abortController.abort();
    alive = false;
  }

  function forceKill(): void {
    if (abortController) abortController.abort();
    alive = false;
  }

  function getStatus(): LLMStatus {
    return {
      alive,
      busy: responseResolvers.length > 0,
      spawnedAt,
      lastActivityAt,
      backend: config.backend,
    };
  }

  return {
    isAlive,
    isPendingRetry,
    cancelRetry,
    send,
    waitForResponse,
    kill,
    forceKill,
    onExit: (cb) => exitCallbacks.push(cb),
    onChunk: (cb) => chunkCallbacks.push(cb),
    onRateLimit: (cb) => rateLimitCallbacks.push(cb),
    onApiError: (cb) => apiErrorCallbacks.push(cb),
    onActivity: (cb) => activityCallbacks.push(cb),
    onToolUse: (cb) => toolUseCallbacks.push(cb),
    onModel: () => {},
    getStatus,
  };
}
