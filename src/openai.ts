import { resolve, basename, dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import type { Config, LLMManager, LLMStatus, Mode } from "./types.js";
import { TOOLS_BY_MODE } from "./types.js";

const MAX_TURNS = 50;
const RATE_LIMIT_RETRY_DELAY = 30_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const API_ERROR_RETRY_DELAYS = [30_000, 60_000];

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

function getToolDefinitions(mode: Mode): ToolDef[] {
  const tools: ToolDef[] = [];
  const allowed = TOOLS_BY_MODE[mode];
  if (!allowed) return tools;

  const names = allowed.split(",").map(s => s.trim());

  if (names.includes("Read")) {
    tools.push({
      type: "function",
      function: {
        name: "Read",
        description: "Read a file from the filesystem. Returns content with line numbers. Use this instead of Bash commands like cat/head/tail. For large files, use offset and limit to read specific sections rather than reading the entire file.",
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
        description: "Search file contents using regex (powered by ripgrep). Returns matching lines with file paths and line numbers. Use this instead of Bash grep/rg commands. Use the context parameters (-A, -B, -C) to see surrounding code — this avoids needing a separate Read call after finding a match. Use glob or type to narrow the search to specific file types.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "File or directory to search in (default: working directory)" },
            glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts', '*.{js,jsx}')" },
            type: { type: "string", description: "File type filter (e.g. 'ts', 'py', 'rust', 'go')" },
            context: { type: "number", description: "Show N lines before AND after each match (like grep -C)" },
            before: { type: "number", description: "Show N lines before each match (like grep -B)" },
            after: { type: "number", description: "Show N lines after each match (like grep -A)" },
            max_count: { type: "number", description: "Max matches per file (default 100)" },
            case_insensitive: { type: "boolean", description: "Case-insensitive search (default false)" },
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
        description: "Find files matching a glob pattern. Returns file paths sorted by name. Use this instead of Bash find/ls commands. Use '**/' prefix to search recursively (e.g. '**/*.ts' finds all TypeScript files in all subdirectories).",
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
        description: "Fetch a URL and return its content as clean readable text. HTML pages are automatically converted to text (scripts, styles, nav, and boilerplate are stripped). Use this to read documentation, API references, blog posts, etc. Will not work for pages that require authentication. For search, use WebSearch instead.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to fetch (must be fully-formed, e.g. https://...)" },
            raw: { type: "boolean", description: "Return raw HTML instead of extracted text (default false)" },
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
        description: "List files and directories at a given path. Returns names with type indicators (/ for directories) and file sizes. Use this to explore project structure. For finding specific files by name pattern, use Glob instead.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path to list (default: working directory)" },
          },
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
    case "ListDirectory": return `ListDir ${args?.path ? pathFn(args.path) : "."}`;
    case "WebFetch": return `WebFetch: ${(args?.url || "").slice(0, 100)}`;
    case "WebSearch": return `WebSearch: ${(args?.query || "").slice(0, 100)}`;
    case "Think": return `Think (${(args?.thought || "").slice(0, 60)}...)`;
    default: return name;
  }
}

async function executeTool(name: string, args: any, workDir: string): Promise<string> {
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
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const start = Math.max(0, (args.offset || 1) - 1);
  const limit = args.limit || 2000;
  const selected = lines.slice(start, start + limit);
  return selected.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
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
  const rgArgs = ["rg", "--no-heading", "-n", "--max-count", String(maxCount)];
  if (args.case_insensitive) rgArgs.push("-i");
  if (args.glob) rgArgs.push("--glob", args.glob);
  if (args.type) rgArgs.push("--type", args.type);
  // Context lines: -C takes precedence, then individual -A/-B
  if (args.context) {
    rgArgs.push("-C", String(args.context));
  } else {
    if (args.before) rgArgs.push("-B", String(args.before));
    if (args.after) rgArgs.push("-A", String(args.after));
  }
  rgArgs.push(args.pattern);
  if (args.path) rgArgs.push(args.path);

  const result = Bun.spawnSync(rgArgs, { cwd: workDir, timeout: 30_000 });
  const output = result.stdout?.toString() || "";
  if (output.length > 50_000) {
    return output.slice(0, 50_000) + "\n... (truncated)";
  }
  return output || "(no matches)";
}

async function toolGlob(args: any, workDir: string): Promise<string> {
  const glob = new Bun.Glob(args.pattern);
  const dir = args.path ? resolve(workDir, args.path) : workDir;
  const matches: string[] = [];
  for await (const file of glob.scan({ cwd: dir })) {
    matches.push(file);
    if (matches.length >= 200) {
      matches.push("... (truncated at 200 results)");
      break;
    }
  }
  return matches.join("\n") || "(no matches)";
}

async function toolListDir(args: any, workDir: string): Promise<string> {
  const dirPath = args.path ? resolve(workDir, args.path) : workDir;
  if (!existsSync(dirPath)) return `Error: Directory not found: ${args.path || "."}`;

  const entries = readdirSync(dirPath);
  const lines: string[] = [];

  for (const entry of entries.sort()) {
    try {
      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        lines.push(`${entry}/`);
      } else {
        const size = stat.size;
        const sizeStr = size < 1024 ? `${size}B`
          : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)}K`
          : `${(size / (1024 * 1024)).toFixed(1)}M`;
        lines.push(`${entry}  (${sizeStr})`);
      }
    } catch {
      lines.push(`${entry}  (unreadable)`);
    }
    if (lines.length >= 500) {
      lines.push("... (truncated at 500 entries)");
      break;
    }
  }

  return lines.join("\n") || "(empty directory)";
}

async function toolPatch(args: any, workDir: string): Promise<string> {
  const filePath = resolve(workDir, args.file_path);
  if (!existsSync(filePath)) return `Error: File not found: ${args.file_path}`;
  if (!Array.isArray(args.edits) || args.edits.length === 0) return "Error: edits array is empty";

  let content = readFileSync(filePath, "utf-8");
  const results: string[] = [];

  for (let i = 0; i < args.edits.length; i++) {
    const edit = args.edits[i];
    if (!edit.old_string || edit.new_string === undefined) {
      results.push(`Edit ${i + 1}: Error — missing old_string or new_string`);
      continue;
    }
    const idx = content.indexOf(edit.old_string);
    if (idx === -1) {
      results.push(`Edit ${i + 1}: Error — old_string not found`);
      continue;
    }
    if (content.indexOf(edit.old_string, idx + edit.old_string.length) !== -1) {
      results.push(`Edit ${i + 1}: Error — old_string is not unique`);
      continue;
    }
    content = content.slice(0, idx) + edit.new_string + content.slice(idx + edit.old_string.length);
    results.push(`Edit ${i + 1}: OK`);
  }

  writeFileSync(filePath, content);
  return results.join("\n");
}

async function toolWebFetch(args: any): Promise<string> {
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
    let text = await resp.text();
    const contentType = resp.headers.get("content-type") || "";

    // Convert HTML to readable text unless raw mode requested
    if (!args.raw && (contentType.includes("text/html") || contentType.includes("xhtml") || text.trimStart().startsWith("<"))) {
      text = htmlToText(text);
    }

    if (text.length > 50_000) {
      return text.slice(0, 50_000) + "\n... (truncated)";
    }
    return text || "(empty response)";
  } finally {
    clearTimeout(timeout);
  }
}

/** Convert HTML to clean readable text, stripping boilerplate */
function htmlToText(html: string): string {
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
    .replace(/<\/?(p|div|section|article|main|aside|blockquote|figure|figcaption|details|summary)[^>]*>/gi, "\n")
    .replace(/<\/?(h[1-6])[^>]*>/gi, "\n")
    .replace(/<\/?li[^>]*>/gi, "\n")
    .replace(/<\/?tr[^>]*>/gi, "\n")
    .replace(/<\/?td[^>]*>/gi, "\t")
    .replace(/<\/?th[^>]*>/gi, "\t")
    .replace(/<\/?(ul|ol|table|thead|tbody|tfoot)[^>]*>/gi, "\n");

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

function parseDDGResults(html: string, maxResults: number): string {
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

function stripHtml(html: string): string {
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

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const err = new Error(`${response.status}: ${errorText.slice(0, 500)}`);
      (err as any).status = response.status;
      throw err;
    }

    // Detect response format: SSE vs plain JSON
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await response.json();
      const result = parseNonStreamingResponse(json);
      if (result.content) emitChunk(result.content);
      return result;
    }

    // Default: treat as SSE stream
    return processStreamingResponse(response, emitChunk, signal);
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

    while (turns < MAX_TURNS) {
      turns++;
      lastActivityAt = Date.now();

      if (signal.aborted) return accumulatedText || "[Request cancelled]";

      let result: TurnResult;
      try {
        result = await apiRequest(messages, tools, signal);
      } catch (err: any) {
        if (signal.aborted) return accumulatedText || "[Request cancelled]";

        const status = err?.status as number | undefined;
        if (status === 429) {
          // Rate limit — emit callback but don't retry here (let it bubble)
          return accumulatedText || `[Rate limited: ${err.message}]`;
        }
        if (status && status >= 500) {
          return accumulatedText || `[API Error: ${err.message}]`;
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

          const toolResult = await executeTool(tc.name, args, config.workDir);
          lastActivityAt = Date.now();

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
