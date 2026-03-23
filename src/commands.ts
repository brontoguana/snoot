import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, chmodSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import type { Config, CommandResult, ContextStore, LLMManager, Mode } from "./types.js";
import { VERSION } from "./version.js";
import { endpointDisplayName } from "./utils.js";

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
          `Snoot v${VERSION}`,
          "",
          "Commands:",
          "  /help — show this message",
          "  /boop — check if LLM is busy and when it last did something",
          "  /status — show current state",
          "  /context — show summary and pins",
          `  /mode <chat|research|coding> — switch mode (current: ${config.mode})`,
          `  /endpoint [name] — switch endpoint or list available`,
          `  /claude — shortcut for /endpoint claude`,
          `  /gemini — shortcut for /endpoint gemini`,
          `  /model <name> — switch model (e.g. opus, sonnet, gemini-2.5-pro)`,
          `  /effort <level> — set effort (low/medium/high/max/default)`,
          "  /pin <text> — pin context that survives compaction",
          "  /unpin <id> — remove a pinned item",
          "  /profile <description> — generate avatar from description",
          "  /profile + image — set attached image as avatar",
          "  /btw <question> — side question (can read code, no edits)",
          "  /rename <name> — change display name (restarts)",
          "  /move <name> — move to new channel (restarts, new chat on phone)",
          "  /save <name> + attachment — save file to working directory",
          "  /overwrite <name> + attachment — same, but allows overwriting",
          `  ${config.channel}.snoot.md — per-instance prompt (in project dir)`,
          "  /compact — force context compaction",
          "  /stop — cancel the current request",
          "  /restart — restart the snoot process",
          "  /forget or /clear — clear all context and restart",
        ].join("\n"),
      };

    case "/boop":
    case "/hi":
    case "/update": {
      const status = llm.getStatus();
      const name = endpointDisplayName(config.backend);
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
      const statusName = endpointDisplayName(config.backend);
      const epType = config.endpointConfig?.type === "openai" ? ` (openai: ${config.endpointConfig.url})` : "";
      return {
        response: [
          `Transport: ${config.transport}`,
          `Endpoint: ${config.backend}${epType}`,
          `Model: ${config.model || "default"}`,
          `Effort: ${config.effort !== undefined ? config.effort : "default"}`,
          `Mode: ${config.mode}`,
          `${statusName}: ${llm.isAlive() ? "processing" : "idle"}`,
          `Messages: ${state.totalPairs} total, ${context.getRecent().length} in window`,
          `Pins: ${state.pins.length}`,
          `Context budget: ${config.contextBudget} tokens`,
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

    case "/profile":
      return {
        response: "Usage: /profile <description> to generate an avatar, or send /profile with an attached image.",
      };

    case "/save":
    case "/overwrite": {
      if (!args) {
        return { response: `Usage: ${cmd} <name> — attach a file or image to save.` };
      }
      return { response: `${cmd} requires an attached file or image. Resend with an attachment.` };
    }

    case "/rename": {
      if (!args) {
        return { response: "Usage: /rename <new display name>" };
      }
      const identityFile = `${config.baseDir}/identity.json`;
      if (!existsSync(identityFile)) {
        return { response: "No identity file found — only works with Session transport." };
      }
      try {
        const identity = JSON.parse(readFileSync(identityFile, "utf-8"));
        identity.displayName = args;
        writeFileSync(identityFile, JSON.stringify(identity, null, 2));
        try { chmodSync(identityFile, 0o600); } catch {}
      } catch (err) {
        return { response: `Failed to update identity: ${err instanceof Error ? err.message : String(err)}` };
      }
      return {
        response: `Display name changed to "${args}". Restarting...`,
        restartProcess: true,
      };
    }

    case "/move": {
      if (!args) {
        return { response: "Usage: /move <new channel name>\n\nWarning: this creates a new Session identity, so you'll lose message history in the phone app. Server-side context (summary, pins, etc.) is preserved. Use /rename if you just want to change the display name." };
      }
      const newChannel = args.replace(/[^a-zA-Z0-9_-]/g, "");
      if (!newChannel) {
        return { response: "Invalid name. Use only letters, numbers, hyphens, and underscores." };
      }
      if (newChannel.toLowerCase() === config.channel.toLowerCase()) {
        return { response: `Already named "${config.channel}".` };
      }

      const oldBaseDir = config.baseDir;
      const newBaseDir = resolve(dirname(oldBaseDir), newChannel);
      const instancesDir = resolve(homedir(), ".snoot", "instances");

      if (existsSync(newBaseDir)) {
        return { response: `Channel "${newChannel}" already exists in this project.` };
      }

      try {
        // 1. Rename the data directory
        renameSync(oldBaseDir, newBaseDir);

        // 2. Rename the per-instance prompt file if it exists
        const oldPrompt = resolve(config.workDir, `${config.channel}.snoot.md`);
        const newPrompt = resolve(config.workDir, `${newChannel}.snoot.md`);
        if (existsSync(oldPrompt) && !existsSync(newPrompt)) {
          renameSync(oldPrompt, newPrompt);
        }

        // 3. Update launch.json with new channel name in args
        const launchFile = resolve(newBaseDir, "launch.json");
        if (existsSync(launchFile)) {
          try {
            const launch = JSON.parse(readFileSync(launchFile, "utf-8"));
            if (Array.isArray(launch.args)) {
              // First positional arg is the channel name
              const idx = launch.args.indexOf(config.channel);
              if (idx !== -1) launch.args[idx] = newChannel;
              writeFileSync(launchFile, JSON.stringify(launch));
            }
          } catch {}
        }

        // 4. Update instance registry
        const oldRegistry = resolve(instancesDir, `${config.channel}.json`);
        const newRegistry = resolve(instancesDir, `${newChannel}.json`);
        if (existsSync(oldRegistry)) {
          try {
            const inst = JSON.parse(readFileSync(oldRegistry, "utf-8"));
            inst.channel = newChannel;
            if (Array.isArray(inst.args)) {
              const idx = inst.args.indexOf(config.channel);
              if (idx !== -1) inst.args[idx] = newChannel;
            }
            writeFileSync(newRegistry, JSON.stringify(inst, null, 2));
            unlinkSync(oldRegistry);
          } catch {}
        }
      } catch (err) {
        return { response: `Move failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      return {
        response: `Moving "${config.channel}" to "${newChannel}". This will start a new chat on your phone (server-side context is preserved). Restarting...`,
        moveChannel: newChannel,
      };
    }

    case "/stop":
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
