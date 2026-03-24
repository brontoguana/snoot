import { readFileSync } from "fs";
import path from "path";
import type { Config, LLMManager } from "./types.js";
import { createBaseLLMManager, type OutputEvent } from "./llm-base.js";

function shortPath(p: string): string {
  const dir = path.basename(path.dirname(p));
  const file = path.basename(p);
  return dir && dir !== "." ? `${dir}/${file}` : file;
}

function formatToolUse(item: any, pathFn: (p: string) => string = shortPath): string {
  if (item.type === "command_execution") {
    const cmd = (item.command || "").replace(/^\/bin\/bash\s+-lc\s+/, "").slice(0, 120);
    return `Bash: ${cmd}`;
  }
  return item.type || "unknown";
}

export function createCodexManager(config: Config): LLMManager {
  return createBaseLLMManager(config, {
    label: "codex",
    backend: "codex",

    spawn(cfg, text, promptFile) {
      // Build the full prompt: system prompt from file + user message
      let fullPrompt = text;
      if (promptFile) {
        try {
          const systemPrompt = readFileSync(promptFile, "utf-8");
          fullPrompt = systemPrompt + "\n\n" + text;
        } catch (err) {
          console.error("[codex] Error reading prompt file:", err);
        }
      }

      const args = [
        cfg.cliPath || "codex",
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--ephemeral",
        "-",
      ];

      if (cfg.model) args.push("-m", cfg.model);

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

      console.log(`[codex] Args: ${args.join(" ")}`);
      return proc;
    },

    parseOutput(json): OutputEvent[] {
      const events: OutputEvent[] = [];

      switch (json.type) {
        case "item.completed": {
          const item = json.item;
          if (!item) break;

          if (item.type === "agent_message" && item.text) {
            events.push({ kind: "text", text: item.text });
          } else if (item.type === "command_execution") {
            const detail = formatToolUse(item);
            const trackingDetail = `Bash: ${(item.command || "").slice(0, 200)}`;
            events.push({ kind: "tool_use", detail, trackingDetail });
          }
          break;
        }
        case "item.started": {
          const item = json.item;
          if (item?.type === "command_execution") {
            const detail = formatToolUse(item);
            events.push({ kind: "log", message: `Tool started: ${detail}` });
          }
          break;
        }
        case "turn.completed": {
          // turn.completed is the "result" signal — codex is done
          events.push({ kind: "result", text: "" });
          break;
        }
        case "thread.started":
          events.push({ kind: "log", message: `Thread: ${json.thread_id}` });
          break;
        case "turn.started":
          events.push({ kind: "log", message: "Turn started" });
          break;
        case "error": {
          const message = json.message || JSON.stringify(json);
          const lower = (typeof message === "string" ? message : "").toLowerCase();
          if (lower.includes("rate") || lower.includes("limit") || lower.includes("429")) {
            events.push({ kind: "rate_limit" });
          }
          events.push({ kind: "log", message: `Error: ${message}` });
          break;
        }
      }

      return events;
    },

    isApiError(text) {
      return text.includes("Internal server error") ||
             text.includes("API error") ||
             text.includes("overloaded");
    },
  });
}
