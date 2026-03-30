import path from "path";
import type { Config, LLMManager } from "./types.js";
import { TOOLS_BY_MODE } from "./types.js";
import { createBaseLLMManager, type OutputEvent } from "./llm-base.js";

function shortPath(p: string): string {
  const dir = path.basename(path.dirname(p));
  const file = path.basename(p);
  return dir && dir !== "." ? `${dir}/${file}` : file;
}

function formatToolUse(name: string, input: any, pathFn: (p: string) => string = shortPath): string {
  switch (name) {
    case "Read": return `Read ${input?.file_path ? pathFn(input.file_path) : ""}`;
    case "Edit": return `Edit ${input?.file_path ? pathFn(input.file_path) : ""}`;
    case "Write": return `Write ${input?.file_path ? pathFn(input.file_path) : ""}`;
    case "Bash": return `Bash: ${(input?.command || "").slice(0, 120)}`;
    case "Grep": return `Grep "${input?.pattern || ""}" in ${input?.path ? pathFn(input.path) : "."}`;
    case "Glob": return `Glob ${input?.pattern || ""}`;
    case "WebSearch": return `WebSearch: ${(input?.query || "").slice(0, 100)}`;
    case "WebFetch": return `WebFetch: ${(input?.url || "").slice(0, 100)}`;
    default: return name;
  }
}

export function createClaudeManager(config: Config): LLMManager {
  return createBaseLLMManager(config, {
    label: "claude",
    backend: "claude",

    spawn(cfg, text, promptFile) {
      const tools = TOOLS_BY_MODE[cfg.mode];
      const args = [
        cfg.cliPath || "claude",
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
        "--no-session-persistence",
      ];

      if (cfg.model) args.push("--model", cfg.model);
      if (cfg.effort !== undefined) args.push("--effort", cfg.effort);
      if (cfg.budgetUsd !== undefined) args.push("--max-budget-usd", cfg.budgetUsd.toString());
      if (promptFile) args.push("--append-system-prompt-file", promptFile);

      if (tools) {
        args.push("--tools", tools);
      } else {
        args.push("--tools", "");
      }

      const env = { ...process.env };
      delete env.CLAUDECODE;

      const proc = Bun.spawn(args, {
        cwd: cfg.workDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      // Write prompt to stdin, then close
      try {
        const stdin = proc.stdin as import("bun").FileSink;
        stdin.write(text);
        stdin.end();
      } catch (err) {
        try { proc.kill("SIGKILL"); } catch {}
        throw err;
      }

      console.log(`[claude] Args: ${args.join(" ")}`);
      return proc;
    },

    parseOutput(json): OutputEvent[] {
      const events: OutputEvent[] = [];

      switch (json.type) {
        case "assistant": {
          const content = json.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                events.push({ kind: "text", text: block.text });
              } else if (block.type === "tool_use") {
                events.push({ kind: "tool_use", detail: formatToolUse(block.name, block.input), trackingDetail: formatToolUse(block.name, block.input, p => p) });
              }
            }
          }
          break;
        }
        case "system": {
          const raw = JSON.stringify(json).toLowerCase();
          if (raw.includes("rate") || raw.includes("limit") || raw.includes("throttl") || raw.includes("429") || raw.includes("overloaded")) {
            events.push({ kind: "rate_limit", reason: JSON.stringify(json).slice(0, 200) });
            events.push({ kind: "log", message: `Rate limit detected: ${JSON.stringify(json).slice(0, 200)}` });
          } else {
            events.push({ kind: "log", message: `System message: ${JSON.stringify(json).slice(0, 200)}` });
          }
          break;
        }
        case "rate_limit_event": {
          const info = json.rate_limit_info;
          const status = info?.status;
          if (status && status !== "allowed") {
            events.push({ kind: "rate_limit", reason: json.message || `rate limited (${status})` });
          }
          events.push({ kind: "log", message: `Rate limit event: ${JSON.stringify(json).slice(0, 300)}` });
          break;
        }
        case "result":
          events.push({ kind: "result", text: (json as any).result || "" });
          break;
      }

      return events;
    },

    isApiError(text) {
      return text.includes("API Error: 500") ||
             text.includes('"type":"api_error"') ||
             text.includes("Internal server error");
    },
  });
}
