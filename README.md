# Snoot

A proxy that bridges [Session](https://getsession.org) encrypted messenger with AI coding assistants, letting you chat with Claude or Gemini about your codebase from your phone.

Messages flow: **Session app** → **Snoot proxy** → **Claude/Gemini process** → **back to Session**.

## How It Works

Snoot uses an ephemeral per-message model — each message (or batch of rapid messages) spawns a fresh AI process, gets a response, and exits. The proxy owns all conversation state and manages context compaction between requests.

- When a message arrives, Snoot builds a context prompt (summary + pins + recent history) and spawns a new process.
- Multiple messages sent in quick succession are batched into a single request.
- For long-running requests, partial responses stream back progressively (every 30s for the first minute, then 60s, then every 2 minutes).
- Responses containing inline SVG diagrams are automatically converted to PNG images and sent through Session.

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and on PATH (optional, for Gemini backend)
- A Session account/ID for the user

## Install

```bash
git clone https://github.com/brontoguana/snoot.git
cd snoot
bun install
```

To make `snoot` available globally, create a wrapper script on your PATH:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/snoot << 'EOF'
#!/bin/bash
exec bun /path/to/snoot/src/index.ts "$@"
EOF
chmod +x ~/.local/bin/snoot
```

## Usage

```
snoot <channel> [options]
snoot shutdown [channel]
snoot restart [channel]
snoot ps
snoot cron
snoot nocron
snoot set-user <session-id>
```

### First-time setup

```bash
# Save your Session ID globally (once)
snoot set-user 05abc123...
```

This saves to `~/.snoot/user.json` and is used for all projects unless overridden with `--user`.

### Starting a channel

```bash
# Start snoot (runs in background, logs to .snoot/<channel>/snoot.log)
snoot mychannel

# With options
snoot mychannel --mode research --backend gemini

# Run in foreground (for debugging)
snoot mychannel --fg

# Override user for this project
snoot mychannel --user 05def456...
```

Run this from the project directory you want the AI to work on. Snoot daemonizes by default — it verifies startup, then detaches and logs to `.snoot/<channel>/snoot.log`.

### Stopping

```bash
# Stop a specific channel
snoot shutdown mychannel

# Stop all running instances
snoot shutdown
```

### Restarting

```bash
# Restart with saved args (works from any directory)
snoot restart mychannel

# Restart all running instances
snoot restart
```

### Listing instances

```bash
# Show all running instances with PID and project directory
snoot ps
```

### Boot persistence

```bash
# Add @reboot cron entries for all registered instances
snoot cron

# Remove all snoot entries from crontab
snoot nocron
```

Running `snoot cron` multiple times is safe — it skips channels that already have entries. Each instance restarts in its original working directory with its original launch args on reboot.

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--user <session-id>` | User's Session ID (overrides saved ID) | — |
| `--mode <mode>` | Tool mode: `chat`, `research`, or `coding` | `coding` |
| `--backend <backend>` | AI backend: `claude` or `gemini` | `claude` |
| `--budget <usd>` | Max budget per message in USD | unlimited |
| `--compact-at <n>` | Trigger compaction at N message pairs | `20` |
| `--window <n>` | Keep N pairs after compaction | `15` |
| `--fg` | Run in foreground instead of daemonizing | off |

Budget can also be set globally in `~/.snoot/config.json`:
```json
{ "budgetUsd": 2.00 }
```

### Modes

- **chat** — No tools. AI can only respond with text.
- **research** — Read-only tools: Read, Grep, Glob, WebSearch, WebFetch.
- **coding** — Full tools: Read, Grep, Glob, Edit, Write, Bash, WebSearch, WebFetch.

## Session Commands

Send these from your phone in the Session chat:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/boop` or `/update` | Quick status check — is the AI busy? When was it last active? |
| `/status` | Show full state (backend, mode, process status, message count) |
| `/context` | Show summary and pinned items |
| `/mode <mode>` | Switch mode (chat/research/coding) |
| `/claude` | Switch to Claude backend |
| `/gemini` | Switch to Gemini backend |
| `/pin <text>` | Pin context that survives compaction |
| `/unpin <id>` | Remove a pinned item |
| `/profile <description>` | Generate and set an avatar from a text description |
| `/compact` | Force context compaction now |
| `/stop` | Cancel the current request |
| `/restart` | Restart the snoot process |
| `/forget` or `/clear` | Clear all context and start fresh |

## SVG Image Support

When the AI wants to show a table, diagram, chart, or any structured visual, it embeds an inline SVG in its response. Snoot automatically:

1. Detects SVG blocks in the response text.
2. Converts each SVG to a PNG image (800px wide, via resvg-js).
3. Sends the PNG through Session as an image message.
4. Sends surrounding text as separate text messages.

For example, if the AI responds with an explanation, then a diagram, then more explanation — you'll receive three Session messages: text, image, text.

SVGs are stripped from conversation history (replaced with `[image]`) to save context space.

## Avatar Generation

The `/profile <description>` command generates a custom avatar for the Snoot bot:

1. You send `/profile a cyberpunk crow` (or any description).
2. The AI generates an SVG matching your description using the Write tool.
3. Snoot converts it to a 256x256 PNG and sets it as the Session profile picture.
4. The avatar is cached and restored automatically when the instance restarts.

## Context Management

Snoot manages conversation context across ephemeral AI processes:

- **Recent messages** are kept in a sliding window (`recent.jsonl`)
- **Compaction** runs automatically when the window hits the threshold — older messages are summarized by a fast model (Haiku) and the window is trimmed
- **Pins** survive compaction, ensuring important context is never lost
- **Daily archives** (`archive/archive-YYYY-MM-DD.jsonl`) keep a full append-only history with 30-day retention
- **Summary** (`summary.md`) is a rolling compacted summary fed to each new AI process

All state lives in `.snoot/<channel>/` within your project directory.

## Progressive Streaming

For requests that take more than 30 seconds, Snoot streams partial responses back to your phone so you're not left waiting:

- **0–1 min**: flushes accumulated text every 30 seconds
- **1–4 min**: every 60 seconds
- **4+ min**: every 2 minutes

Short responses are sent all at once as usual.

## Error Handling

- **Rate limits**: Automatically retries after 30 seconds, up to 5 attempts. Notifies you of each retry.
- **API errors (500)**: Same auto-retry with backoff and notification.
- **Empty responses**: Detects and reports when the AI returns nothing (usually a budget or rate limit issue).

## Project Structure

```
src/
├── index.ts      # CLI entry point, arg parsing, PID lock, daemonization
├── proxy.ts      # Core orchestration, message batching, SVG extraction
├── claude.ts     # Claude process lifecycle, stream-json I/O
├── gemini.ts     # Gemini process lifecycle, stream-json I/O
├── context.ts    # Context store, compaction, prompt building
├── session.ts    # Session client, message chunking, image sending
├── commands.ts   # /slash command handler
├── profile.ts    # Avatar generation, SVG-to-PNG conversion
└── types.ts      # Shared types and interfaces
```

## License

Private.
