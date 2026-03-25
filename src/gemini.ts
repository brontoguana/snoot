import { readFileSync } from "fs";
import path from "path";
import type { Config, LLMManager } from "./types.js";
import { createBaseLLMManager, type OutputEvent } from "./llm-base.js";

function shortPath(p: string): string {
  const dir = path.basename(path.dirname(p));
  const file = path.basename(p);
  return dir && dir !== "." ? `${dir}/${file}` : file;
}

function formatToolUse(name: string, input: any, pathFn: (p: string) => string = shortPath): string {
  switch (name) {
    case "read_file": return `Read ${input?.file_path ? pathFn(input.file_path) : ""}`;
    case "replace": return `Edit ${input?.file_path ? pathFn(input.file_path) : ""}`;
    case "write_file": return `Write ${input?.file_path ? pathFn(input.file_path) : ""}`;
    case "run_shell_command": return `Bash: ${(input?.command || "").slice(0, 120)}`;
    case "grep_search": return `Grep "${input?.pattern || ""}" in ${input?.dir_path ? pathFn(input.dir_path) : "."}`;
    case "glob": return `Glob ${input?.pattern || ""}`;
    case "google_web_search": return `WebSearch: ${(input?.query || "").slice(0, 100)}`;
    case "web_fetch": return `WebFetch: ${(input?.url || "").slice(0, 100)}`;
    default: return name;
  }
}

export function createGeminiManager(config: Config): LLMManager {
  return createBaseLLMManager(config, {
    label: "gemini",
    backend: "gemini",

    spawn(cfg, text, promptFile) {
      // Build the full prompt: system prompt from file + user message
      let fullPrompt = text;
      if (promptFile) {
        try {
          const systemPrompt = readFileSync(promptFile, "utf-8");
          fullPrompt = systemPrompt + "\n\n" + text;
        } catch (err) {
          console.error("[gemini] Error reading prompt file:", err);
        }
      }

      const args = [
        cfg.cliPath || "gemini",
        "-o", "stream-json",
        "--yolo",
      ];

      if (cfg.model) args.push("-m", cfg.model);
      // We pass an empty prompt via -p to force headless mode,
      // then write the actual content to stdin.
      args.push("-p", "");

      const proc = Bun.spawn(args, {
        cwd: cfg.workDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      // Write prompt to stdin, then close
      try {
        const stdin = proc.stdin as import("bun").FileSink;
        stdin.write(fullPrompt);
        stdin.end();
      } catch (err) {
        try { proc.kill("SIGKILL"); } catch {}
        throw err;
      }

      return proc;
    },

    parseOutput(json): OutputEvent[] {
      const events: OutputEvent[] = [];

      switch (json.type) {
        case "message": {
          const role = json.role as string;
          const content = json.content as string;
          if (role === "assistant" && content) {
            events.push({ kind: "text", text: content });
          }
          break;
        }
        case "error": {
          const message = (json.message as string) || "";
          const severity = (json.severity as string) || "error";
          const lower = message.toLowerCase();
          if (lower.includes("rate") || lower.includes("limit") || lower.includes("quota") || lower.includes("429")) {
            events.push({ kind: "rate_limit" });
          }
          events.push({ kind: "log", message: `Error (${severity}): ${message}` });
          break;
        }
        case "result":
          // Gemini results come via accumulated text chunks, not the result event
          events.push({ kind: "result", text: "" });
          break;
        case "init":
          if (json.model) events.push({ kind: "model", model: json.model });
          events.push({ kind: "log", message: `Session initialized: model=${json.model}` });
          break;
        case "tool_use":
          events.push({ kind: "tool_use", detail: formatToolUse(json.tool_name, json.parameters), trackingDetail: formatToolUse(json.tool_name, json.parameters, p => p) });
          break;
        case "tool_result":
          events.push({ kind: "log", message: `Tool result: ${json.tool_id} (${json.status})` });
          break;
      }

      return events;
    },

    isApiError(text) {
      return text.includes("Internal server error") || text.includes("INTERNAL");
    },
  });
}
