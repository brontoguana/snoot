import { join, resolve, extname, delimiter as PATH_DELIMITER } from "path";
import { existsSync, writeFileSync, appendFileSync, readFileSync, watch as fsWatch, mkdirSync, renameSync, cpSync, readdirSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import type { Config, LLMManager, TransportClient, Backend, Mode, IncomingMessage, IncomingAttachment, EndpointConfig } from "./types.js";
import { VERSION } from "./version.js";
import { createSessionClient } from "./session.js";
import { createMatrixClient } from "./matrix.js";
import { createSimplexClient } from "./simplex.js";
import { createClaudeManager } from "./claude.js";
import { createGeminiManager } from "./gemini.js";
import { createCodexManager } from "./codex.js";
import { createOpenAIManager } from "./openai.js";
import { createContextStore } from "./context.js";
import { handleCommand } from "./commands.js";
import { buildProfilePrompt, convertAvatarSvg, svgToPng, extractSvgBlocks, initResvg } from "./profile.js";
import { findCliPath, loadEndpoints, saveEndpoint, removeEndpoint, endpointDisplayName } from "./utils.js";

const IS_WINDOWS = process.platform === "win32";

function backendEmoji(backend: string, ep?: EndpointConfig): string {
  const cli = ep?.cli || backend;
  if (cli === "claude" || backend === "claude") return "⚡";
  if (cli === "gemini" || backend === "gemini") return "💎";
  if (cli === "codex" || backend === "codex") return "🧬";
  return "🌀";
}

function thinkingStatus(config: Config): string {
  const emoji = backendEmoji(config.backend, config.endpointConfig);
  const parts = [emoji, `${config.windowSize}msg`];
  if (config.model) {
    const display = config.model.replace(/^gemini-/i, "");
    parts.push(display);
  }
  if (config.effort) parts.push(config.effort);
  return parts.join(" · ");
}

function createLLM(config: Config): LLMManager {
  const ep = config.endpointConfig;
  if (ep?.type === "openai") {
    return createOpenAIManager(config);
  }
  const cli = ep?.cli || config.backend;
  if (cli === "gemini") return createGeminiManager(config);
  if (cli === "codex") return createCodexManager(config);
  return createClaudeManager(config);
}

export function createProxy(config: Config) {
  const context = createContextStore(config);
  let llm: LLMManager = createLLM(config);
  let sessionClient: TransportClient;
  let processing = false;
  let processingStartedAt = 0;
  const PROCESSING_TIMEOUT = 5 * 60_000; // 5 minutes — force-reset if stuck
  let messageQueue: string[] = [];
  let shuttingDown = false;
  let pendingAvatar = false;
  let pendingCliInstall = false;
  let autoMessage: string | null = null; // /auto mode: message to re-inject after each LLM response
  type BufferEntry = { type: "text"; content: string } | { type: "tool"; content: string };
  let chunkBuffer: BufferEntry[] = [];
  let textCharsSent = 0;
  let contextTrace: string[] = []; // full trace for context: text + tool-use interleaved
  let svgCarryover = ""; // holds incomplete SVG text between flush intervals
  const FLUSH_INTERVAL = 30_000;

  const avatarSvgPath = join(config.baseDir, "avatar.svg");
  const watchLogPath = join(config.baseDir, "watch.log");
  const settingsPath = join(config.baseDir, "settings.json");

  /** Persist backend/model/effort so they survive restarts */
  function saveSettings(): void {
    const data: Record<string, string | number> = { backend: config.backend };
    if (config.model) data.model = config.model;
    if (config.effort) data.effort = config.effort;
    if (config.windowSize) data.windowSize = config.windowSize;
    try { writeFileSync(settingsPath, JSON.stringify(data)); } catch {}
  }

  // Truncate watch log on startup so it only shows the current session
  writeFileSync(watchLogPath, "");

  function watchLog(line: string): void {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    appendFileSync(watchLogPath, `${time}  ${line}\n`);
  }

  /** Send a response that may contain inline SVG blocks, <attach> tags, or both */
  async function sendRichResponse(text: string): Promise<void> {
    const segments = extractSvgBlocks(text);

    // No rich content — send as plain text
    if (segments.length === 1 && segments[0].type === "text") {
      await sessionClient.send(segments[0].content);
      return;
    }
    if (segments.length === 0) return;

    for (const segment of segments) {
      if (segment.type === "text") {
        await sessionClient.send(segment.content);
      } else if (segment.type === "svg") {
        try {
          const png = svgToPng(segment.content);
          await sessionClient.sendImage(png);
          console.log(`[proxy] Sent inline SVG as PNG (${png.length} bytes)`);
        } catch (err) {
          console.error("[proxy] Failed to convert inline SVG:", err);
          await sessionClient.send("[Image failed to render]");
        }
      } else if (segment.type === "attach") {
        try {
          const filePath = resolve(config.workDir, segment.content);
          // Security: restrict to working directory
          if (!filePath.startsWith(resolve(config.workDir))) {
            await sessionClient.send(`[Attachment blocked — path outside working directory]`);
            continue;
          }
          if (!existsSync(filePath)) {
            await sessionClient.send(`[Attachment not found: ${segment.content}]`);
            continue;
          }
          await sessionClient.sendFile(filePath);
          console.log(`[proxy] Sent file attachment: ${segment.content}`);
        } catch (err) {
          console.error("[proxy] Failed to send attachment:", err);
          await sessionClient.send(`[Attachment failed: ${segment.content}]`);
        }
      }
    }
  }

  function wireLLMCallbacks(): void {
    llm.onRateLimit(async (retryIn, attempt, reason) => {
      const reasonShort = reason ? reason.slice(0, 120) : "rate limited";
      const msg = `⏳ ${reasonShort}\nRetrying in ${retryIn}s (attempt ${attempt}/5)\nSend /stop to cancel or /model to switch models`;
      watchLog(msg);
      try {
        await sessionClient.send(msg);
      } catch {}
    });

    llm.onApiError(async (retryIn, attempt, maxAttempts, reason) => {
      const reasonShort = reason ? reason.slice(0, 120) : "API error";
      const msg = `⚠️ ${reasonShort}\nRetrying in ${retryIn}s (attempt ${attempt}/${maxAttempts})\nSend /stop to cancel or /model to switch models`;
      watchLog(msg);
      try {
        if (attempt <= maxAttempts) {
          await sessionClient.send(msg);
        }
      } catch {}
    });

    llm.onChunk((text) => {
      chunkBuffer.push({ type: "text", content: text });
      contextTrace.push(text);
      // Stream LLM output to watch log in real-time
      const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const logLines = text.split('\n').map(l => `${time}  │ ${l}\n`).join('');
      appendFileSync(watchLogPath, logLines);
    });

    llm.onToolUse((detail) => {
      contextTrace.push(`[${detail}]`);
      context.trackToolUse(detail);
    });

    llm.onActivity((line) => {
      watchLog(line);
      // Capture tool calls into buffer for user messages
      if (line.startsWith("🔧")) {
        chunkBuffer.push({ type: "tool", content: line });
      }
    });

    llm.onModel((model) => {
      if (!config.model) {
        config.model = model;
        watchLog(`Model detected: ${model}`);
      }
    });

    llm.onExit(async () => {
      if (shuttingDown) return;
      // If we're not currently processing a message, this is an unexpected exit
      // (e.g. Claude was killed externally). Notify the user.
      if (!processing) {
        watchLog("⚠️ LLM process exited unexpectedly");
      }
    });
  }

  async function switchEndpoint(name: string): Promise<string> {
    const endpoints = loadEndpoints();
    const ep = endpoints[name];
    if (!ep) {
      const available = Object.keys(endpoints);
      return `Unknown endpoint "${name}". Available: ${available.join(", ") || "none"}`;
    }
    if (name === config.backend) {
      return `Already using ${name}.`;
    }
    if (llm.isAlive()) await llm.kill();
    config.backend = name;
    config.endpointConfig = ep;
    config.model = undefined; // reset model — old backend's model won't work on new one
    if (ep.type === "cli") {
      config.cliPath = findCliPath(ep.cli || name);
    }
    llm = createLLM(config);
    wireLLMCallbacks();
    saveSettings();
    return `Switched to ${name}. Next message will use ${name}.`;
  }

  const VALID_EFFORTS = ["low", "medium", "high", "max"];

  function handleEffortCommand(arg: string): void {
    if (!arg) {
      const current = config.effort ?? "default";
      const options = [
        `Current effort: ${current}`,
        "",
        "Options:",
        "  /effort low — minimal thinking",
        "  /effort medium — balanced",
        "  /effort high — deeper reasoning",
        "  /effort max — maximum thinking",
        "  /effort default — reset to default",
      ];
      sessionClient.send(options.join("\n")).catch(() => {});
      return;
    }

    const cli = config.endpointConfig?.cli || config.backend;
    if (cli !== "claude") {
      sessionClient.send("Effort is only supported for Claude CLI endpoints.").catch(() => {});
      return;
    }

    const lower = arg.toLowerCase();

    if (lower === "default" || lower === "off" || lower === "none") {
      if (config.effort === undefined) {
        sessionClient.send("Already using default effort.").catch(() => {});
        return;
      }
      config.effort = undefined;
      if (llm.isAlive()) llm.kill();
      saveSettings();
      watchLog("🔄 Effort → default");
      sessionClient.send("Effort reset to default. Next message will use it.").catch(() => {});
      return;
    }

    if (VALID_EFFORTS.includes(lower)) {
      if (config.effort === lower) {
        sessionClient.send(`Already set to ${lower}.`).catch(() => {});
        return;
      }
      config.effort = lower;
      if (llm.isAlive()) llm.kill();
      saveSettings();
      watchLog(`🔄 Effort → ${lower}`);
      sessionClient.send(`Effort set to ${lower}. Next message will use it.`).catch(() => {});
      return;
    }

    sessionClient.send("Invalid effort. Use: low, medium, high, max, or default.").catch(() => {});
  }

  async function handleBtw(question: string): Promise<void> {
    watchLog(`💬 /btw: ${question.slice(0, 200)}`);
    try {
      await sessionClient.send("💬 " + thinkingStatus(config));
    } catch {}

    // Spawn a throwaway LLM in research mode (read-only tools, no edits)
    const btwConfig: Config = {
      ...config,
      mode: "research" as Mode,
    };
    const btwLlm = createLLM(btwConfig);

    // Write a temp system prompt instructing no edits
    const btwPromptFile = join(config.workDir, ".snoot", config.channel, "btw-prompt.txt");
    const btwPrompt = [
      "You are answering a quick side question. You have read-only access to the codebase — you can read files, search, and browse the web to answer the question.",
      "Do NOT edit, write, or create any files. Do NOT run shell commands. Do NOT take any actions that modify the project.",
      "Just answer the question concisely and move on. This is a one-off question separate from any ongoing work.",
    ].join("\n");
    await Bun.write(btwPromptFile, btwPrompt);

    btwLlm.send(question, btwPromptFile);

    const BTW_TIMEOUT = 10 * 60 * 1000; // 10 minutes
    let timedOut = false;
    const timeout = new Promise<string | null>((resolve) =>
      setTimeout(() => { timedOut = true; resolve(null); }, BTW_TIMEOUT)
    );
    const response = await Promise.race([btwLlm.waitForResponse(), timeout]);

    if (timedOut) {
      watchLog("⚠️ /btw timed out after 10 minutes, killing process");
      btwLlm.forceKill();
      try {
        await sessionClient.send("/btw timed out after 10 minutes.");
      } catch {}
      return;
    }

    if (response) {
      watchLog(`💬 /btw response (${response.length} chars)`);
      try {
        await sendRichResponse(response);
      } catch {}
    } else {
      try {
        await sessionClient.send("No response received.");
      } catch {}
    }
  }

  async function handleUpdate(): Promise<void> {
    watchLog(`🔄 /update: updating snoot`);
    try {
      await sessionClient.send(`Current version: v${VERSION}\nDownloading latest...`);
    } catch {}

    try {
      // Download and run the install script
      const curlProc = Bun.spawn(["curl", "-fsSL", "https://raw.githubusercontent.com/brontoguana/snoot/main/install.sh"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const script = await new Response(curlProc.stdout).text();
      const curlExit = await curlProc.exited;
      if (curlExit !== 0 || !script.trim()) {
        const stderr = await new Response(curlProc.stderr).text();
        watchLog(`❌ /update: failed to download install script: ${stderr}`);
        try { await sessionClient.send("Update failed: couldn't download install script."); } catch {}
        return;
      }

      // Write the script to a temp file and execute it
      const scriptPath = join(config.baseDir, "update.sh");
      writeFileSync(scriptPath, script);

      const bashProc = Bun.spawn(["bash", scriptPath], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: homedir() },
      });
      const stdout = await new Response(bashProc.stdout).text();
      const stderr = await new Response(bashProc.stderr).text();
      const exitCode = await bashProc.exited;

      try { unlinkSync(scriptPath); } catch {}

      if (exitCode !== 0) {
        watchLog(`❌ /update: install script failed (exit ${exitCode}): ${stderr}`);
        try { await sessionClient.send(`Update failed (exit ${exitCode}):\n${stderr || stdout}`); } catch {}
        return;
      }

      // Extract installed version from output
      const versionMatch = stdout.match(/Installed:\s+(\S+)/);
      const newVersion = versionMatch ? versionMatch[1] : "unknown";
      watchLog(`✅ /update: updated to ${newVersion}`);

      if (newVersion === `v${VERSION}`) {
        try { await sessionClient.send(`Already on latest version (v${VERSION}).`); } catch {}
        return;
      }

      try {
        await sessionClient.send(`Updated: v${VERSION} -> ${newVersion}\nRestarting...`);
      } catch {}

      // Give the message time to send, then restart
      await new Promise(r => setTimeout(r, 1000));
      process.exit(0); // daemon will respawn with new binary
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      watchLog(`❌ /update: error: ${msg}`);
      try { await sessionClient.send(`Update failed: ${msg}`); } catch {}
    }
  }

  async function handleReport(userQuestion?: string): Promise<void> {
    watchLog(`📊 /report: generating progress report`);

    // Prepend LLM status (what /update used to show)
    const status = llm.getStatus();
    const name = endpointDisplayName(config.backend);
    const statusParts: string[] = [];
    if (!status.alive) {
      statusParts.push(`${name}: idle`);
    } else {
      const now = Date.now();
      const ago = (ts: number) => {
        const secs = Math.floor((now - ts) / 1000);
        if (secs < 60) return `${secs}s ago`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m ${secs % 60}s ago`;
        return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
      };
      statusParts.push(`${name}: processing`);
      if (status.spawnedAt) statusParts.push(`Started: ${ago(status.spawnedAt)}`);
      if (status.lastActivityAt) statusParts.push(`Last activity: ${ago(status.lastActivityAt)}`);
    }

    try {
      await sessionClient.send(`${statusParts.join("\n")}\n\n📊 Generating report...`);
    } catch {}

    // Spawn a throwaway LLM in research mode so it can read the watch log
    const reportConfig: Config = {
      ...config,
      mode: "research" as Mode,
    };
    const reportLlm = createLLM(reportConfig);

    const reportPromptFile = join(config.workDir, ".snoot", config.channel, "report-prompt.txt");
    const reportPrompt = [
      "You are reviewing the work log of an AI coding assistant.",
      `Read the log file and produce a SHORT progress report. Format:`,
      "",
      `Line 1: The snoot instance name "${config.channel}"`,
      `Line 2: The watch log path`,
      "",
      "Then exactly two short paragraphs:",
      "Paragraph 1: What the agent is working on — its current task and goal.",
      "Paragraph 2: The progress it has made — what's done, what's in flight, any blockers.",
      "",
      "That's it. No event lists, no bullet points, no timestamps, no numbered items. Just two concise paragraphs.",
      "Use plain text, no markdown. Do NOT edit, write, or create any files.",
      ...(userQuestion ? [
        "",
        `After the report, add a blank line and then answer this question from the user: "${userQuestion}"`,
      ] : []),
    ].join("\n");
    await Bun.write(reportPromptFile, reportPrompt);

    const question = `Read this work log and provide a progress report: ${watchLogPath}`;
    reportLlm.send(question, reportPromptFile);

    const REPORT_TIMEOUT = 3 * 60 * 1000; // 3 minutes
    let timedOut = false;
    const timeout = new Promise<string | null>((resolve) =>
      setTimeout(() => { timedOut = true; resolve(null); }, REPORT_TIMEOUT)
    );
    const response = await Promise.race([reportLlm.waitForResponse(), timeout]);

    if (timedOut) {
      watchLog("⚠️ /report timed out after 3 minutes, killing process");
      reportLlm.forceKill();
      try {
        await sessionClient.send("/report timed out.");
      } catch {}
      return;
    }

    if (response) {
      watchLog(`📊 /report response (${response.length} chars)`);
      try {
        await sendRichResponse(`📊 ${response}`);
      } catch {}
    } else {
      try {
        await sessionClient.send("📊 No report generated — the log may be empty.");
      } catch {}
    }
  }

  async function handleReportAll(): Promise<void> {
    watchLog(`📊 /report all: generating reports for all active snoots`);

    // Find all active watch logs from the instance registry
    const instancesDir = resolve(homedir(), ".snoot", "instances");
    if (!existsSync(instancesDir)) {
      try { await sessionClient.send("📊 No snoot instances found."); } catch {}
      return;
    }

    const now = Date.now();
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const activeLogs: { channel: string; path: string }[] = [];

    for (const entry of readdirSync(instancesDir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const inst = JSON.parse(readFileSync(resolve(instancesDir, entry), "utf-8"));
        const logPath = resolve(inst.cwd, ".snoot", inst.channel, "watch.log");
        if (!existsSync(logPath)) continue;
        const stat = statSync(logPath);
        if (now - stat.mtimeMs < EIGHT_HOURS) {
          activeLogs.push({ channel: inst.channel, path: logPath });
        }
      } catch {}
    }

    if (activeLogs.length === 0) {
      try { await sessionClient.send("📊 No active snoots found (no watch logs modified in the last 8 hours)."); } catch {}
      return;
    }

    try {
      await sessionClient.send(`📊 Generating reports for ${activeLogs.length} active snoot${activeLogs.length > 1 ? "s" : ""}...`);
    } catch {}

    const reportPromptFile = join(config.workDir, ".snoot", config.channel, "report-all-prompt.txt");
    const reportPrompt = [
      "You are reviewing the work log of an AI coding assistant (called a snoot).",
      "Read the log file and produce a SHORT progress report. Format:",
      "",
      "Line 1: The snoot instance name",
      "Line 2: The watch log path",
      "",
      "Then exactly two short paragraphs:",
      "Paragraph 1: What the agent is working on — its current task and goal.",
      "Paragraph 2: The progress it has made — what's done, what's in flight, any blockers.",
      "",
      "That's it. No event lists, no bullet points, no timestamps, no numbered items. Just two concise paragraphs.",
      "Use plain text, no markdown. Do NOT edit, write, or create any files.",
    ].join("\n");
    await Bun.write(reportPromptFile, reportPrompt);

    const REPORT_TIMEOUT = 3 * 60 * 1000;

    // Process each snoot sequentially with a 3-second gap between reports
    for (let i = 0; i < activeLogs.length; i++) {
      const log = activeLogs[i];

      if (i > 0) {
        // Wait 3 seconds between reports
        await new Promise(r => setTimeout(r, 3000));
      }

      watchLog(`📊 /report all: generating report for ${log.channel} (${i + 1}/${activeLogs.length})`);

      const reportConfig: Config = {
        ...config,
        mode: "research" as Mode,
      };
      const reportLlm = createLLM(reportConfig);

      const question = `Read this work log and provide a progress report for snoot instance "${log.channel}":\n${log.path}`;
      reportLlm.send(question, reportPromptFile);

      let timedOut = false;
      const timeout = new Promise<string | null>((resolve) =>
        setTimeout(() => { timedOut = true; resolve(null); }, REPORT_TIMEOUT)
      );
      const response = await Promise.race([reportLlm.waitForResponse(), timeout]);

      if (timedOut) {
        watchLog(`⚠️ /report all: ${log.channel} timed out after 3 minutes, killing`);
        reportLlm.forceKill();
        try { await sessionClient.send(`📊 ${log.channel}: timed out.`); } catch {}
        continue;
      }

      if (response) {
        watchLog(`📊 /report all: ${log.channel} response (${response.length} chars)`);
        try {
          await sendRichResponse(`📊 ${response}`);
        } catch {}
      } else {
        try {
          await sessionClient.send(`📊 ${log.channel}: no report generated — log may be empty.`);
        } catch {}
      }
    }
  }

  async function start(): Promise<void> {
    try {
      await initResvg();
    } catch (err) {
      console.error("[proxy] Failed to init resvg WASM:", err);
    }
    try {
      await context.load();
    } catch (err) {
      console.error("[proxy] Failed to load context, starting fresh:", err);
    }
    sessionClient = config.transport === "simplex"
      ? await createSimplexClient(config)
      : config.transport === "matrix"
      ? await createMatrixClient(config)
      : await createSessionClient(config);

    wireLLMCallbacks();

    await sessionClient.startListening(onMessage);
    console.log(`[proxy] Ready. Transport: ${config.transport}, Mode: ${config.mode}, Endpoint: ${config.backend}`);
    watchLog(`🟢 Snoot online — ${config.transport} / ${config.backend} / ${config.mode} / ${config.workDir}`);

    // Wait for session to connect, then re-upload avatar before greeting
    console.log(`[proxy] Waiting 3s for session to settle...`);
    await new Promise(r => setTimeout(r, 3000));
    console.log(`[proxy] Re-uploading avatar...`);
    try {
      await sessionClient.reuploadAvatar();
      console.log(`[proxy] Avatar done.`);
    } catch (err) {
      console.error(`[proxy] Avatar re-upload failed:`, err);
    }

    // Greet the user so the conversation appears in their Session app
    console.log(`[proxy] Sending greeting...`);
    try {
      await sessionClient.send(
        `✅ Snoot online\n${thinkingStatus(config)} · ${config.mode}\n${config.workDir}\nSend /help for commands.`
      );
      console.log(`[proxy] Greeting sent.`);
    } catch (err) {
      console.error(`[proxy] Greeting send failed:`, err);
    }

    // If the LLM CLI isn't found, offer to install it
    if (!config.cliPath && config.endpointConfig?.type !== "openai") {
      const cliName = config.endpointConfig?.cli || config.backend;
      const pkg = cliName === "gemini" ? "@anthropic-ai/gemini-code" : "@anthropic-ai/claude-code";
      const installCmd = findInstallCommand(pkg);
      const installHint = installCmd ? `\n\nI'll run: ${installCmd.label}\n\nReply Y to install, or install it yourself and restart.` : `\n\nNo package manager found (npm, bun). Install one first.`;
      console.log(`[proxy] CLI "${cliName}" not found, offering install`);
      try {
        await sessionClient.send(
          `${cliName} CLI not found on this machine. Want me to install it?${installHint}`
        );
      } catch {}
      pendingCliInstall = true;
    }

    // Watch inbox for terminal input (from snoot watch)
    const inboxPath = join(config.baseDir, "inbox");
    writeFileSync(inboxPath, "");
    let inboxOffset = 0;

    fsWatch(inboxPath, () => {
      try {
        const content = readFileSync(inboxPath, "utf-8");
        if (content.length <= inboxOffset) return;
        const newContent = content.slice(inboxOffset);
        inboxOffset = content.length;
        for (const line of newContent.split("\n")) {
          if (!line.trim()) continue;
          try {
            const { text } = JSON.parse(line);
            if (text) onMessage({ text, attachments: [] });
          } catch {}
        }
      } catch {}
    });
  }

  function findInstallCommand(pkg: string): { cmd: string[]; label: string } | undefined {
    // Try npm, bun, then npx/bunx as fallbacks
    const candidates: { finder: string; cmd: (p: string) => string[]; label: string }[] = [
      { finder: "npm", cmd: (p) => ["npm", "install", "-g", p], label: "npm install -g" },
      { finder: "bun", cmd: (p) => ["bun", "install", "-g", p], label: "bun install -g" },
    ];
    for (const c of candidates) {
      const path = findCliPath(c.finder);
      if (path) return { cmd: c.cmd(pkg).map((s, i) => i === 0 ? path : s), label: `${c.label} ${pkg}` };
    }
    // Last resort: npx
    const npxPath = findCliPath("npx");
    if (npxPath) return { cmd: [npxPath, "-y", pkg], label: `npx -y ${pkg}` };
    const bunxPath = findCliPath("bunx");
    if (bunxPath) return { cmd: [bunxPath, pkg], label: `bunx ${pkg}` };
    return undefined;
  }

  async function installCli(): Promise<void> {
    const cliName = config.endpointConfig?.cli || config.backend;
    const pkg = cliName === "gemini" ? "@anthropic-ai/gemini-code" : "@anthropic-ai/claude-code";
    pendingCliInstall = false;

    const installCmd = findInstallCommand(pkg);
    if (!installCmd) {
      console.error(`[proxy] No package manager found (npm, bun, npx, bunx)`);
      watchLog(`❌ No package manager found`);
      try {
        await sessionClient.send(`No package manager (npm, bun) found on this machine. Install one first, then restart.`);
      } catch {}
      return;
    }

    watchLog(`📦 Installing: ${installCmd.label}`);
    try {
      await sessionClient.send(`Installing with: ${installCmd.label}\nThis may take a few minutes...`);
    } catch {}

    try {
      const result = Bun.spawnSync(installCmd.cmd, {
        cwd: config.workDir,
        env: process.env,
        timeout: 600_000, // 10 min timeout
      });

      const stdout = result.stdout?.toString().trim() || "";
      const stderr = result.stderr?.toString().trim() || "";

      if (result.exitCode === 0) {
        // Re-resolve CLI path
        config.cliPath = findCliPath(cliName);
        if (config.cliPath) {
          console.log(`[proxy] CLI installed successfully: ${config.cliPath}`);
          watchLog(`✅ ${cliName} installed: ${config.cliPath}`);
          try {
            await sessionClient.send(`${cliName} installed successfully. Ready to go!`);
          } catch {}
        } else {
          console.error(`[proxy] Install succeeded but CLI still not found`);
          watchLog(`⚠️ Install succeeded but ${cliName} not found on PATH`);
          try {
            await sessionClient.send(`Install succeeded but ${cliName} still not found on PATH. You may need to restart snoot.`);
          } catch {}
        }
      } else {
        console.error(`[proxy] Install failed (exit ${result.exitCode}): ${stderr || stdout}`);
        watchLog(`❌ Install failed: ${stderr || stdout}`);
        const errMsg = (stderr || stdout).slice(0, 500);
        try {
          await sessionClient.send(`Install failed (exit ${result.exitCode}):\n${errMsg}\n\nTry installing manually and restart.`);
        } catch {}
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proxy] Install error:`, err);
      watchLog(`❌ Install error: ${msg}`);
      try {
        await sessionClient.send(`Install error: ${msg}`);
      } catch {}
    }
  }

  function onMessage(msg: IncomingMessage): void {
    const trimmed = msg.text.trim();

    // Handle pending CLI install confirmation
    if (pendingCliInstall && /^y(es)?$/i.test(trimmed)) {
      installCli();
      return;
    }
    if (pendingCliInstall && /^n(o)?$/i.test(trimmed)) {
      pendingCliInstall = false;
      sessionClient.send("OK. Install the CLI manually and restart snoot when ready.").catch(() => {});
      return;
    }

    // Log all incoming messages to watch
    const logText = trimmed || (msg.attachments.length > 0 ? `[${msg.attachments.length} attachment(s)]` : "");
    watchLog(`← ${logText.slice(0, 1000)}${logText.length > 1000 ? "..." : ""}`);

    // /save and /overwrite with attachment — save file to working directory
    const saveMatch = trimmed.match(/^\/(save|overwrite)\s+(.+)/i);
    if (saveMatch && msg.attachments.length > 0) {
      const allowOverwrite = saveMatch[1].toLowerCase() === "overwrite";
      handleSaveFile(saveMatch[2].trim(), msg.attachments[0], allowOverwrite);
      return;
    }

    // /profile with image attachment — set avatar directly, no LLM needed
    if (trimmed.match(/^\/profile\s*$/i) && msg.attachments.length > 0) {
      // Use first attachment — don't require contentType since session.js may not provide it
      handleProfileImage(msg.attachments[0]);
      return;
    }

    // /endpoint — switch, list, add, or remove endpoints (bypass queue)
    const endpointMatch = trimmed.match(/^\/endpoint\s*(.*)/i);
    if (endpointMatch !== null) {
      const endpointArg = endpointMatch[1].trim();
      if (!endpointArg) {
        // List all endpoints
        const endpoints = loadEndpoints();
        const lines = Object.entries(endpoints).map(([name, ep]) => {
          const active = name === config.backend ? " (active)" : "";
          const desc = ep.type === "cli" ? `cli: ${ep.cli || name}` : `openai: ${ep.url}`;
          return `  ${name} — ${desc}${active}`;
        });
        const epMsg = lines.length > 0
          ? `Endpoints:\n${lines.join("\n")}\n\nUse /endpoint <name> to switch, /endpoint add or /endpoint remove to manage.`
          : "No endpoints configured.\n\nUse /endpoint add <name> <url> <model> to add one.";
        sessionClient.send(epMsg).catch(() => {});
        return;
      }

      const endpointParts = endpointArg.split(/\s+/);
      const subCmd = endpointParts[0].toLowerCase();

      // /endpoint add <name> [url] [model] [apikey]
      if (subCmd === "add" || subCmd === "create" || subCmd === "new") {
        const epName = endpointParts[1];
        if (!epName) {
          sessionClient.send(
            "Usage:\n" +
            "  /endpoint add <name> <url> [model] [apikey]\n" +
            "  /endpoint add <name>  (CLI, auto-detect binary)\n\n" +
            "Examples:\n" +
            "  /endpoint add local http://localhost:11434/v1 qwen2.5:72b\n" +
            "  /endpoint add deepseek https://api.deepseek.com/v1 deepseek-chat sk-abc123"
          ).catch(() => {});
          return;
        }
        const epUrl = endpointParts[2];
        if (epUrl && (epUrl.startsWith("http://") || epUrl.startsWith("https://"))) {
          // OpenAI-compatible endpoint
          const epModel = endpointParts[3] || undefined;
          const epApiKey = endpointParts[4] || undefined;
          const ep: EndpointConfig = { type: "openai", url: epUrl, model: epModel, apiKey: epApiKey };
          saveEndpoint(epName, ep);
          const parts = [`Endpoint "${epName}" added (openai: ${epUrl})`];
          if (epModel) parts.push(`Model: ${epModel}`);
          parts.push(`\nUse /endpoint ${epName} to switch to it.`);
          sessionClient.send(parts.join("\n")).catch(() => {});
        } else {
          // CLI endpoint
          const cliName = epUrl || epName; // optional second arg overrides binary name
          const ep: EndpointConfig = { type: "cli", cli: cliName };
          saveEndpoint(epName, ep);
          const cliPath = findCliPath(cliName);
          const status = cliPath ? `found at ${cliPath}` : "NOT found on PATH";
          sessionClient.send(`Endpoint "${epName}" added (cli: ${cliName}, ${status})\n\nUse /endpoint ${epName} to switch to it.`).catch(() => {});
        }
        watchLog(`➕ Added endpoint: ${epName}`);
        return;
      }

      // /endpoint remove <name>
      if (subCmd === "remove" || subCmd === "delete" || subCmd === "rm") {
        const epName = endpointParts[1];
        if (!epName) {
          sessionClient.send("Usage: /endpoint remove <name>").catch(() => {});
          return;
        }
        if (epName === config.backend) {
          sessionClient.send(`Can't remove "${epName}" — it's currently active. Switch to another endpoint first.`).catch(() => {});
          return;
        }
        const removed = removeEndpoint(epName);
        if (removed) {
          watchLog(`➖ Removed endpoint: ${epName}`);
          sessionClient.send(`Endpoint "${epName}" removed.`).catch(() => {});
        } else {
          sessionClient.send(`No endpoint named "${epName}".`).catch(() => {});
        }
        return;
      }

      // Otherwise: switch to the named endpoint
      watchLog(`🔄 Switching to endpoint ${endpointArg}`);
      switchEndpoint(endpointArg).then(msg => sessionClient.send(msg).catch(() => {}));
      return;
    }

    // /claude, /gemini, /codex, /kimi, /glm, etc. — shortcuts for /endpoint <name>
    // Any single-word slash command matching a configured endpoint name works as a switch
    {
      const epCmd = trimmed.match(/^\/(\S+)$/i);
      if (epCmd) {
        const epName = epCmd[1].toLowerCase();
        const endpoints = loadEndpoints();
        if (epName in endpoints) {
          watchLog(`🔄 Switching to ${epName}`);
          switchEndpoint(epName).then(msg => sessionClient.send(msg).catch(() => {}));
          return;
        }
      }
    }

    // /model — switch model (bypass queue)
    const modelMatch = trimmed.match(/^\/model\s*(.*)/i);
    if (modelMatch !== null) {
      const modelArg = modelMatch[1].trim();
      if (!modelArg) {
        const current = config.model || "default";
        const activeCli = config.endpointConfig?.cli || config.backend;
        const options = activeCli === "gemini"
          ? [
              `Current model: ${current}`,
              "",
              "Options:",
              "  /model gemini-2.5-pro",
              "  /model gemini-2.5-flash",
              "  /model gemini-3-pro-preview",
              "  /model gemini-3.1-pro-preview",
              "  /model default",
            ]
          : activeCli === "claude"
          ? [
              `Current model: ${current}`,
              "",
              "Options:",
              "  /model opus (claude-opus-4-6)",
              "  /model sonnet (claude-sonnet-4-6)",
              "  /model haiku (claude-haiku-4-5)",
              "  /model <full-model-id>",
              "  /model default",
            ]
          : [
              `Current model: ${current}`,
              "",
              "  /model <model-name>",
              "  /model default",
            ];
        sessionClient.send(options.join("\n")).catch(() => {});
        return;
      }
      const newModel = modelArg.toLowerCase() === "default" ? undefined : modelArg;
      if (newModel === config.model) {
        sessionClient.send(`Already using ${newModel || "default"} model.`).catch(() => {});
        return;
      }
      config.model = newModel;
      if (llm.isAlive()) llm.kill();
      saveSettings();
      const label = newModel || "default";
      watchLog(`🔄 Model → ${label}`);
      sessionClient.send(`Model set to ${label}. Next message will use it.`).catch(() => {});
      return;
    }

    // /effort — set thinking budget (bypass queue)
    const effortMatch = trimmed.match(/^\/effort\s*(.*)/i);
    if (effortMatch !== null) {
      handleEffortCommand(effortMatch[1].trim());
      return;
    }

    // /auto — auto-repeat a message after each LLM response (bypass queue)
    const autoMatch = trimmed.match(/^\/auto\s*(.*)/i);
    if (autoMatch !== null) {
      const autoArg = autoMatch[1].trim();
      if (!autoArg || autoArg.toLowerCase() === "off" || autoArg.toLowerCase() === "stop") {
        if (autoMessage) {
          autoMessage = null;
          watchLog(`🔄 Auto mode off`);
          sessionClient.send("Auto mode off.").catch(() => {});
        } else {
          sessionClient.send("Auto mode is not active.").catch(() => {});
        }
      } else {
        autoMessage = autoArg;
        watchLog(`🔄 Auto mode on: "${autoArg}"`);
        sessionClient.send(`Auto mode on. Will send "${autoArg}" after each response.\nSend /stop or /auto off to cancel.`).catch(() => {});
        // If idle, kick-start by injecting the auto message now
        if (!processing) {
          watchLog(`🔄 Auto: kick-starting with "${autoArg}"`);
          sessionClient.send(`🤖 ${autoArg}`).catch(() => {});
          messageQueue.push(autoArg);
          processQueue();
        }
      }
      return;
    }

    // /update — self-update snoot by running the install script
    if (trimmed.toLowerCase() === "/update") {
      handleUpdate();
      return;
    }

    // /report — progress report from watch logs (bypass queue)
    if (trimmed.toLowerCase() === "/report all") {
      handleReportAll();
      return;
    }
    const reportMatch = trimmed.match(/^\/report(?:\s+([\s\S]+))?$/i);
    if (reportMatch) {
      handleReport(reportMatch[1]?.trim() || undefined);
      return;
    }

    // /btw — side question in a separate process (bypass queue)
    const btwMatch = trimmed.match(/^\/btw\s+([\s\S]+)/i);
    if (btwMatch) {
      handleBtw(btwMatch[1].trim());
      return;
    }

    // All slash commands bypass the queue so they respond even while LLM is busy
    // Exception: /profile <desc> goes to the LLM for avatar generation
    if (trimmed.startsWith("/") && !trimmed.match(/^\/profile\s+/i)) {
      handleCommandDirect(msg.text);
      return;
    }

    messageQueue.push(msg.text);

    // Watchdog: if processing has been stuck for too long, force-reset
    if (processing && processingStartedAt > 0 && Date.now() - processingStartedAt > PROCESSING_TIMEOUT) {
      const stuckFor = Math.round((Date.now() - processingStartedAt) / 1000);
      console.error(`[proxy] Processing stuck for ${stuckFor}s — force-resetting`);
      watchLog(`⚠️ Processing stuck for ${stuckFor}s — force-resetting`);
      // Kill the old LLM process so the old processQueue() unblocks and exits cleanly
      llm.forceKill();
      processing = false;
    }

    if (!processing) {
      processQueue();
    }
  }

  async function handleProfileImage(attachment: IncomingAttachment): Promise<void> {
    watchLog(`🖼️ Setting avatar from attached image`);
    try {
      const file = await sessionClient.getFile(attachment);
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      await sessionClient.setAvatar(bytes);
      await sessionClient.send("Avatar updated!");
      console.log(`[proxy] Avatar set from attachment (${bytes.length} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[proxy] Avatar from attachment failed:", err);
      try { await sessionClient.send(`Avatar failed: ${msg}`); } catch {}
    }
  }

  function detectImageExtension(contentType?: string, fileName?: string): string | null {
    if (contentType) {
      const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
      };
      if (map[contentType]) return map[contentType];
    }
    // Fallback: try extension from the attachment's original filename
    if (fileName) {
      const match = fileName.match(/\.(\w+)$/);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  async function handleSaveFile(name: string, attachment: IncomingAttachment, allowOverwrite: boolean): Promise<void> {
    const verb = allowOverwrite ? "Overwriting" : "Saving";
    watchLog(`💾 ${verb} file as "${name}"`);
    try {
      const file = await sessionClient.getFile(attachment);
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);

      // If name has no extension and it's an image, autodetect extension
      let filename = name;
      if (!extname(filename)) {
        const ext = detectImageExtension(attachment.contentType, file.name);
        if (ext) {
          filename = `${filename}.${ext}`;
        }
      }

      // Prevent path traversal
      const savePath = resolve(config.workDir, filename);
      if (!savePath.startsWith(resolve(config.workDir))) {
        await sessionClient.send("Invalid filename — cannot save outside working directory.");
        return;
      }

      if (!allowOverwrite && existsSync(savePath)) {
        await sessionClient.send(`File "${filename}" already exists. Use /overwrite ${name} to replace it.`);
        return;
      }

      writeFileSync(savePath, bytes);
      await sessionClient.send(`Saved "${filename}" (${bytes.length} bytes)`);
      console.log(`[proxy] Saved file: ${savePath} (${bytes.length} bytes)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[proxy] Save file failed:", err);
      try { await sessionClient.send(`Save failed: ${errMsg}`); } catch {}
    }
  }

  /** Execute a slash command. Returns true if a command was handled. */
  async function executeCommand(text: string): Promise<boolean> {
    const cmdResult = handleCommand(text, config, context, llm);
    if (!cmdResult) return false;

    const cmd = text.trim().split(/\s+/)[0].toLowerCase();
    // /stop and /kill cancel auto mode
    if ((cmd === "/stop" || cmd === "/kill") && autoMessage) {
      autoMessage = null;
      watchLog(`🔄 Auto mode cancelled by ${cmd}`);
      cmdResult.response += "\nAuto mode cancelled.";
    }
    if (cmd === "/forget" || cmd === "/clear") {
      watchLog(`🗑️ Clearing context`);
      if (llm.isAlive()) await llm.kill();
      await context.reset();
    } else {
      if (cmdResult.relocateDir) {
        watchLog(`📦 Relocating to ${cmdResult.relocateDir}`);
        if (llm.isAlive()) await llm.kill();
        await sessionClient.send(cmdResult.response);
        // Move .snoot/<channel> to new directory
        const oldSnootDir = resolve(config.workDir, ".snoot", config.channel);
        const newSnootDir = resolve(cmdResult.relocateDir, ".snoot", config.channel);
        try {
          mkdirSync(resolve(cmdResult.relocateDir, ".snoot"), { recursive: true });
          if (oldSnootDir !== newSnootDir) {
            cpSync(oldSnootDir, newSnootDir, { recursive: true });
            // Remove old dir after successful copy (renameSync fails across devices)
            const { execSync } = await import("child_process");
            execSync(`rm -rf ${JSON.stringify(oldSnootDir)}`);
          }
          // Update launch.json with new cwd
          const launchFile = resolve(newSnootDir, "launch.json");
          if (existsSync(launchFile)) {
            try {
              const launch = JSON.parse(readFileSync(launchFile, "utf-8"));
              if (launch.cwd) launch.cwd = cmdResult.relocateDir;
              writeFileSync(launchFile, JSON.stringify(launch));
            } catch {}
          }
          // Update instance registry
          const registryFile = resolve(homedir(), ".snoot", "instances", `${config.channel}.json`);
          if (existsSync(registryFile)) {
            try {
              const inst = JSON.parse(readFileSync(registryFile, "utf-8"));
              inst.cwd = cmdResult.relocateDir;
              writeFileSync(registryFile, JSON.stringify(inst, null, 2));
            } catch {}
          }
          // Update cron/scheduled task entry if one exists
          try {
            if (IS_WINDOWS) {
              const batPath = resolve(homedir(), ".snoot", "startup", `${config.channel}.bat`);
              if (existsSync(batPath)) {
                const bat = readFileSync(batPath, "utf-8");
                const updated = bat.replace(/cd \/d "[^"]*"/, `cd /d "${cmdResult.relocateDir}"`);
                if (updated !== bat) writeFileSync(batPath, updated);
              }
            } else {
              const cronResult = Bun.spawnSync(["crontab", "-l"]);
              if (cronResult.exitCode === 0) {
                const crontab = cronResult.stdout.toString();
                const tag = `# snoot:${config.channel}`;
                const lines = crontab.split("\n").map(line => {
                  if (!line.includes(tag)) return line;
                  // Replace cd <old_path> (unquoted or single-quoted) with cd <new_path>
                  const newPath = /^[a-zA-Z0-9._\-\/=:@]+$/.test(cmdResult.relocateDir!)
                    ? cmdResult.relocateDir!
                    : `'${cmdResult.relocateDir!.replace(/'/g, "'\\''")}'`;
                  return line.replace(/cd\s+(?:'[^']*'|\S+)/, `cd ${newPath}`);
                });
                const updated = lines.join("\n");
                if (updated !== crontab) {
                  Bun.spawnSync(["crontab", "-"], { stdin: Buffer.from(updated) });
                }
              }
            }
          } catch {}  // Non-fatal — cron update is best-effort
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          watchLog(`❌ Relocate failed: ${msg}`);
          await sessionClient.send(`Relocate failed: ${msg}`);
          return true;
        }
        Bun.spawn(config.selfCommand, {
          cwd: cmdResult.relocateDir,
          env: process.env,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
        }).unref();
        process.exit(0);
        return true;
      }
      if (cmdResult.restartProcess || cmdResult.moveChannel) {
        watchLog(`🔄 Restarting snoot`);
        if (llm.isAlive()) await llm.kill();
        await sessionClient.send(cmdResult.response);
        let spawnCmd = config.selfCommand;
        if (cmdResult.moveChannel) {
          spawnCmd = spawnCmd.map(a => a === config.channel ? cmdResult.moveChannel! : a);
        }
        Bun.spawn(spawnCmd, {
          cwd: config.workDir,
          env: process.env,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
        }).unref();
        process.exit(0);
        return true;
      }
      if (cmdResult.killProcess && llm.isAlive()) {
        watchLog(`🛑 Stopping process`);
        await llm.kill();
      }
      if (cmdResult.triggerCompaction) {
        watchLog(`📦 Compacting context (aggressive)`);
        // Send immediate feedback before compaction starts
        try { await sessionClient.send("📦 Compacting context..."); } catch {}
        const result = await context.compact(true);
        if (result) {
          try { await sessionClient.send(`✅ Compact done. Summarized ${result.compacted} messages, ${result.remaining} remaining.`); } catch {}
        } else {
          try { await sessionClient.send("Nothing to compact."); } catch {}
        }
        return true; // Skip the default response send
      }
      if (cmdResult.saveWindow) {
        saveSettings();
        watchLog(`📏 Window → ${config.windowSize} messages`);
      }
    }

    try {
      await sessionClient.send(cmdResult.response);
    } catch {}
    return true;
  }

  async function handleCommandDirect(text: string): Promise<void> {
    await executeCommand(text);
  }

  async function processQueue(): Promise<void> {
    processing = true;
    processingStartedAt = Date.now();

    while (messageQueue.length > 0) {
      // Drain and batch all queued messages (commands are handled outside the queue)
      const messages: string[] = [];
      while (messageQueue.length > 0) {
        messages.push(messageQueue.shift()!);
      }

      const batched = messages.length === 1
        ? messages[0]
        : messages.join("\n\n");

      if (messages.length > 1) {
        console.log(`[proxy] Batched ${messages.length} messages into one request`);
      }

      try {
        await handleMessage(batched);
      } catch (err) {
        console.error("[proxy] Error handling message:", err);
        try {
          await sessionClient.send(
            `Error: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        } catch {
          console.error("[proxy] Failed to send error message");
        }
      }

      // Auto mode: re-inject the auto message after each successful response
      if (autoMessage && messageQueue.length === 0) {
        watchLog(`🔄 Auto: injecting "${autoMessage}"`);
        sessionClient.send(`🤖 ${autoMessage}`).catch(() => {});
        messageQueue.push(autoMessage);
      }
    }

    processing = false;
    processingStartedAt = 0;
  }

  /** Promise that resolves when any in-progress flush completes */
  let flushInProgress: Promise<void> = Promise.resolve();

  /** Flush chunk buffer: group entries into messages (each starts with text, followed by tool calls).
   *  @param final — if true, flush everything including incomplete SVGs held in carryover */
  async function flushChunkBuffer(final = false): Promise<void> {
    // Chain flushes so concurrent calls are serialized
    const previous = flushInProgress;
    let resolve!: () => void;
    flushInProgress = new Promise<void>((r) => { resolve = r; });
    // Wait for previous flush, but don't wait forever (prevents deadlock if prior flush hung)
    await Promise.race([previous, new Promise<void>(r => setTimeout(r, 60_000))]);
    if (chunkBuffer.length === 0 && !svgCarryover) { resolve(); return; }

    try {
      const entries = chunkBuffer.splice(0);

      // Prepend any SVG carryover from a previous flush to the first text entry
      if (svgCarryover) {
        const firstTextIdx = entries.findIndex(e => e.type === "text");
        if (firstTextIdx >= 0) {
          entries[firstTextIdx] = { type: "text", content: svgCarryover + entries[firstTextIdx].content };
        } else {
          // No text entries — create one from the carryover
          entries.unshift({ type: "text", content: svgCarryover });
        }
        svgCarryover = "";
      }

      // Merge consecutive text entries so inline SVGs aren't fragmented across chunks
      const merged: typeof entries = [];
      for (const entry of entries) {
        if (entry.type === "text" && merged.length > 0 && merged[merged.length - 1].type === "text") {
          merged[merged.length - 1].content += entry.content;
        } else {
          merged.push({ ...entry });
        }
      }

      // Group entries: each text entry starts a new message group, tools append to current group
      const groups: string[][] = [];
      for (const entry of merged) {
        if (entry.type === "text") {
          groups.push([entry.content]);
          textCharsSent += entry.content.length;
        } else {
          // Tool call — append to last group, or create new one if none exists
          if (groups.length === 0) groups.push([]);
          groups[groups.length - 1].push(entry.content);
        }
      }

      // If not the final flush, check if the last text group has an unclosed SVG.
      // If so, hold it back so it can be completed in the next flush.
      if (!final && groups.length > 0) {
        const lastGroup = groups[groups.length - 1];
        const fullText = lastGroup.join("\n");
        const svgOpens = (fullText.match(/<svg[\s>]/g) || []).length;
        const svgCloses = (fullText.match(/<\/svg>/g) || []).length;
        if (svgOpens > svgCloses) {
          // Incomplete SVG — pull the entire group back into carryover
          svgCarryover = fullText;
          textCharsSent -= lastGroup.filter(l => !l.startsWith("🔧")).join("").length;
          groups.pop();
        }
      }

      // Collapse consecutive identical tool lines within each group (e.g. "🔧 Read foo.ts (x4)")
      for (const group of groups) {
        const collapsed: string[] = [];
        for (const line of group) {
          if (line.startsWith("🔧") && collapsed.length > 0) {
            const prev = collapsed[collapsed.length - 1];
            // Check if previous line is the same tool call (with or without existing count)
            const prevMatch = prev.match(/^(.+?)( \(x(\d+)\))?$/);
            if (prevMatch && prevMatch[1] === line) {
              const count = prevMatch[3] ? parseInt(prevMatch[3]) + 1 : 2;
              collapsed[collapsed.length - 1] = `${line} (x${count})`;
              continue;
            }
          }
          collapsed.push(line);
        }
        group.length = 0;
        group.push(...collapsed);
      }

      // Send each group as a separate Session message
      for (const group of groups) {
        const msg = group.join("\n").trim();
        if (msg) {
          try { await sendRichResponse(msg); } catch {}
        }
      }
    } finally {
      resolve();
    }
  }

  async function handleMessage(text: string): Promise<void> {
    console.log(`[proxy] Received: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

    // Handle /profile — transform into a Claude message
    const profileMatch = text.trim().match(/^\/profile\s+(.+)/i);
    if (profileMatch) {
      pendingAvatar = true;
      const prompt = buildProfilePrompt(profileMatch[1], avatarSvgPath);
      text = prompt;
      // Fall through to normal Claude handling below
    }

    // Check for /commands
    if (await executeCommand(text)) return;

    // Regular message — build full context and spawn fresh process
    const promptFile = context.buildPrompt();
    chunkBuffer = [];
    contextTrace = [];
    textCharsSent = 0;
    svgCarryover = "";
    llm.send(text, promptFile);

    // Send "thinking" indicators
    const backendName = endpointDisplayName(config.backend);
    const thinkingTimer = setTimeout(async () => {
      if (llm.isAlive()) {
        try { await sessionClient.send(thinkingStatus(config)); } catch {}
      }
    }, 5_000);
    // Flush accumulated chunks every 30s
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    flushTimer = setInterval(async () => {
      await flushChunkBuffer();
    }, FLUSH_INTERVAL);

    // Wait for response
    const response = await llm.waitForResponse();
    clearTimeout(thinkingTimer);
    if (flushTimer) clearInterval(flushTimer);

    // Post-response phase: flush, record, send.
    // All Session sends already have a 30s timeout (session.ts), so individual
    // sends can't hang forever.  Wrap the whole block in try/catch so a send
    // failure doesn't leave `processing` stuck.
    try {
      // Flush any remaining entries in the buffer (final=true to send incomplete SVGs too)
      await flushChunkBuffer(true);

      // Empty response — tell the user (only if nothing was streamed)
      if (!response && textCharsSent === 0 && chunkBuffer.length === 0) {
        console.log(`[proxy] ${backendName} returned empty response`);
        await sessionClient.send(`${backendName} returned an empty response — it may have hit a limit. Try again.`);
        return;
      }

      // If this was a /profile request, check for the SVG file and set avatar
      if (pendingAvatar) {
        pendingAvatar = false;
        try {
          if (existsSync(avatarSvgPath)) {
            const png = await convertAvatarSvg(avatarSvgPath);
            await sessionClient.setAvatar(png);
            await sessionClient.send("Avatar updated!");
            console.log(`[proxy] Avatar set (${png.length} bytes)`);
          } else {
            await sessionClient.send("Avatar generation failed: SVG file was not created.");
            console.error("[proxy] Avatar SVG not found at", avatarSvgPath);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error("[proxy] Avatar conversion failed:", err);
          try { await sessionClient.send(`Avatar failed: ${msg}`); } catch {}
        }
        return;
      }

      // Record the exchange in context with full tool-use trace
      const fullTrace = contextTrace.join("")
        .replace(/<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>[\s\S]*?<\/svg>/g, "[image]")
        .replace(/<attach>[\s\S]*?<\/attach>/g, "[attachment]");
      const pair = {
        id: context.nextPairId(),
        user: text,
        assistant: fullTrace || response || "",
        timestamp: Date.now(),
      };
      await context.append(pair);

      // Check if compaction is needed after recording the exchange
      if (context.needsCompaction()) {
        console.log("[proxy] Compaction threshold reached, compacting...");
        await context.compact();
      }

      // If nothing was streamed yet, send the full response now
      if (textCharsSent === 0 && response) {
        watchLog(`→ Sending response (${response.length} chars)`);
        await sendRichResponse(response);
      } else {
        watchLog(`→ Response streamed (${textCharsSent} chars)`);
      }

      // Notify the user that the LLM has finished
      try { await sessionClient.send("✅ Finished"); } catch {}
    } catch (err) {
      console.error("[proxy] Post-response error:", err);
      watchLog(`⚠️ Post-response error: ${err instanceof Error ? err.message : err}`);
      // Try to notify user, but don't let this block either
      try { await sessionClient.send("⚠️ Error delivering response. Send another message to retry."); } catch {}
    }
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    console.log("\n[proxy] Shutting down...");

    if (llm.isAlive()) {
      await llm.kill();
    }

    console.log("[proxy] Goodbye.");
    process.exit(0);
  }

  /** Synchronous fast shutdown — kills LLM immediately, used by SIGTERM handler */
  function forceShutdown(): void {
    shuttingDown = true;
    console.log("\n[proxy] Force shutdown...");
    llm.forceKill();
    console.log("[proxy] Goodbye.");
    process.exit(0);
  }

  return { start, shutdown, forceShutdown };
}
