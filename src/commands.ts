import type { Config, CommandResult, ContextStore, LLMManager, Mode } from "./types.js";

const VALID_MODES: Mode[] = ["chat", "research", "coding"];

export function handleCommand(
  text: string,
  config: Config,
  context: ContextStore,
  llm: LLMManager,
): CommandResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const [cmd, ...rest] = trimmed.split(/\s+/);
  const args = rest.join(" ");

  switch (cmd.toLowerCase()) {
    case "/help":
      return {
        response: [
          "Snoot commands:",
          "  /help — show this message",
          "  /hi — check if LLM is busy and when it last did something",
          "  /status — show current state",
          "  /context — show summary and pins",
          `  /mode <chat|research|coding> — switch mode (current: ${config.mode})`,
          `  /claude — switch to Claude backend`,
          `  /gemini — switch to Gemini backend`,
          "  /pin <text> — pin context that survives compaction",
          "  /unpin <id> — remove a pinned item",
          "  /profile <description> — generate and set avatar from description",
          "  /compact — force context compaction",
          "  /kill — cancel the current request",
          "  /restart — restart the snoot process",
          "  /forget or /clear — clear all context and restart",
        ].join("\n"),
      };

    case "/hi":
    case "/update": {
      const status = llm.getStatus();
      const name = status.backend === "gemini" ? "Gemini" : "Claude";
      if (!status.alive) {
        return { response: `${name} is idle. Send a message to start a new request.` };
      }
      const now = Date.now();
      const ago = (ts: number) => {
        const secs = Math.floor((now - ts) / 1000);
        if (secs < 60) return `${secs}s ago`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m ${secs % 60}s ago`;
        return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
      };
      const parts: string[] = [];
      parts.push(`${name} is processing a request.`);
      if (status.spawnedAt) {
        parts.push(`Started: ${ago(status.spawnedAt)}`);
      }
      if (status.lastActivityAt) {
        parts.push(`Last activity: ${ago(status.lastActivityAt)}`);
      }
      return { response: parts.join("\n") };
    }

    case "/status": {
      const state = context.getState();
      const statusName = config.backend === "gemini" ? "Gemini" : "Claude";
      return {
        response: [
          `Backend: ${config.backend}`,
          `Mode: ${config.mode}`,
          `${statusName}: ${llm.isAlive() ? "processing" : "idle"}`,
          `Messages: ${state.totalPairs} total, ${context.getRecent().length} in window`,
          `Pins: ${state.pins.length}`,
          `Compaction at: ${config.compactAt} messages`,
        ].join("\n"),
      };
    }

    case "/context": {
      const state = context.getState();
      const summary = context.getSummary();
      const parts: string[] = [];

      if (state.pins.length > 0) {
        parts.push("Pinned items:");
        for (const pin of state.pins) {
          parts.push(`  #${pin.id}: ${pin.text}`);
        }
      } else {
        parts.push("No pinned items.");
      }

      if (summary) {
        parts.push("\nSummary:");
        parts.push(summary);
      } else {
        parts.push("\nNo summary yet.");
      }

      parts.push(`\n${context.getRecent().length} messages in current window.`);

      return { response: parts.join("\n") };
    }

    case "/mode": {
      const newMode = args.toLowerCase() as Mode;
      if (!VALID_MODES.includes(newMode)) {
        return {
          response: `Invalid mode. Choose: ${VALID_MODES.join(", ")}`,
        };
      }
      if (newMode === config.mode) {
        return { response: `Already in ${newMode} mode.` };
      }
      config.mode = newMode;
      return {
        response: `Switched to ${newMode} mode. Claude process will restart with new tools.`,
        killProcess: true,
      };
    }

    case "/pin": {
      if (!args) {
        return { response: "Usage: /pin <text to pin>" };
      }
      // addPin is async but we return synchronously — caller handles the promise
      const pin = context.addPin(args);
      // Since addPin returns a promise, we need to handle it
      return {
        response: `Pinned. Use /context to see all pins, /unpin <id> to remove.`,
      };
    }

    case "/unpin": {
      const id = parseInt(args, 10);
      if (isNaN(id)) {
        return { response: "Usage: /unpin <id>" };
      }
      // removePin is async but we return synchronously
      const removed = context.removePin(id);
      return {
        response: `Pin #${id} removed (if it existed). Use /context to see remaining pins.`,
      };
    }

    case "/kill":
      if (!llm.isAlive()) {
        return { response: "Nothing to cancel — idle." };
      }
      return {
        response: "Request cancelled.",
        killProcess: true,
      };

    case "/compact":
      return {
        response: "Compacting context...",
        killProcess: true,
        triggerCompaction: true,
      };

    case "/restart":
      return {
        response: "Restarting snoot...",
        restartProcess: true,
      };

    case "/forget":
    case "/clear":
      return {
        response: "Context cleared. Starting fresh.",
        killProcess: true,
      };

    default:
      return {
        response: `Unknown command: ${cmd}. Type /help for available commands.`,
      };
  }
}
