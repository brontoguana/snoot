import type { Config, CommandResult, ContextStore, ClaudeManager, Mode } from "./types.js";

const VALID_MODES: Mode[] = ["chat", "research", "coding"];

export function handleCommand(
  text: string,
  config: Config,
  context: ContextStore,
  claude: ClaudeManager,
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
          "  /status — show current state",
          "  /context — show summary and pins",
          `  /mode <chat|research|coding> — switch mode (current: ${config.mode})`,
          "  /pin <text> — pin context that survives compaction",
          "  /unpin <id> — remove a pinned item",
          "  /compact — force context compaction",
          "  /forget or /clear — clear all context and restart",
        ].join("\n"),
      };

    case "/status": {
      const state = context.getState();
      return {
        response: [
          `Mode: ${config.mode}`,
          `Claude process: ${claude.isAlive() ? "alive" : "idle"}`,
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

    case "/compact":
      return {
        response: "Compacting context...",
        killProcess: true,
        triggerCompaction: true,
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
