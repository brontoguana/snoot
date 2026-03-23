import { resolve, basename, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import type { Config, LLMManager, LLMStatus, Mode } from "./types.js";
import { TOOLS_BY_MODE } from "./types.js";

const MAX_TURNS = 50;
const RATE_LIMIT_RETRY_DELAY = 30_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const API_ERROR_RETRY_DELAYS = [30_000, 60_000];

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
        description: "Read a file from the filesystem. Returns content with line numbers.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file to read" },
            offset: { type: "number", description: "Line number to start reading from (1-based)" },
            limit: { type: "number", description: "Max number of lines to read" },
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
        description: "Search file contents with regex (uses ripgrep). Returns matching lines with file paths and line numbers.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "File or directory to search in" },
            glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
            type: { type: "string", description: "File type filter (e.g. 'ts', 'py')" },
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
        description: "Find files matching a glob pattern. Returns file paths.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.js')" },
            path: { type: "string", description: "Directory to search in" },
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
        description: "Replace a specific string in a file. old_string must be unique in the file unless replace_all is true.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            old_string: { type: "string", description: "The exact string to find and replace" },
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
        description: "Write content to a file, creating directories if needed. Overwrites existing files.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            content: { type: "string", description: "The content to write" },
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
        description: "Execute a bash command and return its output (stdout + stderr).",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The bash command to execute" },
            timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
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
        description: "Fetch content from a URL and return it as text.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to fetch" },
          },
          required: ["url"],
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

function formatToolUse(name: string, args: any): string {
  switch (name) {
    case "Read": return `Read ${args?.file_path ? shortPath(args.file_path) : ""}`;
    case "Edit": return `Edit ${args?.file_path ? shortPath(args.file_path) : ""}`;
    case "Write": return `Write ${args?.file_path ? shortPath(args.file_path) : ""}`;
    case "Bash": return `Bash: ${(args?.command || "").slice(0, 120)}`;
    case "Grep": return `Grep "${args?.pattern || ""}" in ${args?.path ? shortPath(args.path) : "."}`;
    case "Glob": return `Glob ${args?.pattern || ""}`;
    case "WebFetch": return `WebFetch: ${(args?.url || "").slice(0, 100)}`;
    default: return name;
  }
}

async function executeTool(name: string, args: any, workDir: string): Promise<string> {
  try {
    switch (name) {
      case "Read": return await toolRead(args, workDir);
      case "Edit": return await toolEdit(args, workDir);
      case "Write": return await toolWrite(args, workDir);
      case "Bash": return await toolBash(args, workDir);
      case "Grep": return await toolGrep(args, workDir);
      case "Glob": return await toolGlob(args, workDir);
      case "WebFetch": return await toolWebFetch(args);
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

async function toolBash(args: any, workDir: string): Promise<string> {
  const timeout = args.timeout || 120_000;
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
  const rgArgs = ["rg", "--no-heading", "-n", "--max-count", "100"];
  if (args.glob) rgArgs.push("--glob", args.glob);
  if (args.type) rgArgs.push("--type", args.type);
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

async function toolWebFetch(args: any): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(args.url, { signal: controller.signal });
    const text = await resp.text();
    if (text.length > 50_000) {
      return text.slice(0, 50_000) + "\n... (truncated)";
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
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
    const body: any = { model, messages, stream: true };
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
          console.log(`[${label}] Tool use: ${detail}`);
          emitActivity(`🔧 ${detail}`);
          for (const cb of toolUseCallbacks) cb(detail);

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

      // No tool calls — final response
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
    getStatus,
  };
}
