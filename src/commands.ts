import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, chmodSync, statSync } from "fs";
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
          `  /codex — shortcut for /endpoint codex`,
          `  /model <name> — switch model (e.g. opus, sonnet, gemini-2.5-pro)`,
          `  /effort <level> — set effort (low/medium/high/max/default)`,
          `  /window <n> — set conversation window to n messages`,
          "  /pin <text> — pin context that survives compaction",
          "  /unpin <id> — remove a pinned item",
          "  /profile <description> — generate avatar from description",
          "  /profile + image — set attached image as avatar",
          "  /btw <question> — side question (can read code, no edits)",
          "  /rename <name> — change display name (restarts)",
          "  /move <name> — move to new channel (restarts, new chat on phone)",
          "  /relocate <path> — move to a different working directory",
          "  /save <name> + attachment — save file to working directory",
          "  /overwrite <name> + attachment — same, but allows overwriting",
          `  ${config.channel}.snoot.md — per-instance prompt (in project dir)`,
          "  /compact — force context compaction",
          "  /stop — cancel the current request",
          "  /restart — restart the snoot process",
          "  /forget or /clear — clear all context and restart",
          "",
          "Endpoints:",
          "  Endpoints are named LLM backends. Claude, Gemini, and Codex are",
          "  auto-detected if their CLIs are installed.",
          "",
          "  /endpoint — list all configured endpoints",
          "  /endpoint <name> — switch to an endpoint",
          "  /endpoint add <name> <url> <model> [apikey] — add OpenAI endpoint",
          "  /endpoint add <name> — add CLI endpoint (auto-detect binary)",
          "  /endpoint remove <name> — remove an endpoint",
          "",
          "  Examples:",
          "  /endpoint add local http://localhost:11434/v1 qwen2.5:72b",
          "  /endpoint add deepseek https://api.deepseek.com/v1 deepseek-chat sk-abc",
          "  /endpoint local",
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
          `Window: ${config.windowSize} messages (compact at +10)`,
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

      if (state.recentFiles && state.recentFiles.length > 0) {
        const now = Date.now();
        parts.push("\nRecent files:");
        for (const f of state.recentFiles) {
          const ago = Math.floor((now - f.timestamp) / 60_000);
          const agoStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;
          parts.push(`  ${f.path} (${f.ops.join(",")}) ${agoStr}`);
        }
      }

      if (state.recentCommands && state.recentCommands.length > 0) {
        const now = Date.now();
        parts.push("\nRecent commands:");
        for (const c of state.recentCommands) {
          const ago = Math.floor((now - c.timestamp) / 60_000);
          const agoStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;
          parts.push(`  ${c.cmd} ${agoStr}`);
        }
      }

      if (summary) {
        parts.push("\nSummary:");
        parts.push(summary);
      } else {
        parts.push("\nNo summary yet.");
      }

      parts.push(`\n${context.getRecent().length} messages in window (max ${config.windowSize}).`);

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

    case "/window": {
      if (!args) {
        return {
          response: `Window: ${config.windowSize} messages\nCompaction at: ${config.windowSize + 10} messages\nCurrent: ${context.getRecent().length} messages in window\n\nUsage: /window <n> (e.g. /window 20)`,
        };
      }
      const n = parseInt(args, 10);
      if (isNaN(n) || n < 3) {
        return { response: "Window size must be a number >= 3." };
      }
      config.windowSize = n;
      return {
        response: `Window set to ${n} messages. Auto-compact at ${n + 10}.`,
        killProcess: true,
        saveWindow: true,
      };
    }

    case "/pin": {
      if (!args) {
        return { response: "Usage: /pin <text to pin>" };
      }
      const pinText = `IMPORTANT: ${args}`;
      // addPin updates state synchronously before returning the promise
      context.addPin(pinText);
      const allPins = context.getState().pins;
      const lines = ["Pinned.", ""];
      for (const p of allPins) {
        lines.push(`  #${p.id}: ${p.text}`);
      }
      lines.push("", "Use /unpin <id> to remove.");
      return { response: lines.join("\n") };
    }

    case "/unpin": {
      const id = parseInt(args, 10);
      if (isNaN(id)) {
        return { response: "Usage: /unpin <id>" };
      }
      const removed = context.removePin(id);
      if (!removed) {
        return { response: `Pin #${id} not found. Use /context to see current pins.` };
      }
      const preview = removed.text.length > 80 ? removed.text.slice(0, 80) + "..." : removed.text;
      return {
        response: `Removed pin #${id}: ${preview}`,
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

    case "/relocate": {
      if (!args) {
        return { response: `Usage: /relocate <path>\n\nMoves this snoot to work in a different directory. Accepts relative paths (including ../).\n\nCurrent: ${config.workDir}` };
      }
      const targetDir = resolve(config.workDir, args);
      if (targetDir === resolve(config.workDir)) {
        return { response: `Already working in ${config.workDir}` };
      }
      if (!existsSync(targetDir)) {
        return { response: `Directory not found: ${targetDir}` };
      }
      try {
        const stat = statSync(targetDir);
        if (!stat.isDirectory()) {
          return { response: `Not a directory: ${targetDir}` };
        }
      } catch {
        return { response: `Cannot access: ${targetDir}` };
      }
      return {
        response: `Relocating to ${targetDir}. Restarting...`,
        relocateDir: targetDir,
      };
    }

    case "/stop":
    case "/kill":
      if (llm.isPendingRetry()) {
        llm.cancelRetry();
        return { response: "Retry cancelled." };
      }
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
