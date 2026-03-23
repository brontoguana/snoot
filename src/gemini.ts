import { readFileSync } from "fs";
import type { Config, LLMManager } from "./types.js";
import { createBaseLLMManager, type OutputEvent } from "./llm-base.js";

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
      args.push("-p", fullPrompt);

      return Bun.spawn(args, {
        cwd: cfg.workDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
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
          events.push({ kind: "log", message: `Session initialized: model=${json.model}` });
          break;
        case "tool_use":
          events.push({ kind: "tool_use", detail: String(json.tool_name || "unknown tool") });
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
