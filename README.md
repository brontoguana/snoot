# Snoot

A proxy that bridges [Session](https://getsession.org) encrypted messenger with [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), letting you chat with Claude about your codebase from your phone.

Messages flow: **Session app** → **Snoot proxy** → **Claude Code process** → **back to Session**.

## How It Works

Snoot uses a hybrid ephemeral model — short-lived Claude processes with streaming JSON I/O that stay alive for a burst of activity, then exit. The proxy owns all conversation state and manages context compaction between bursts.

- When a message arrives and no Claude process is running, Snoot builds a context prompt (summary + pins + recent history) and spawns a new `claude` process.
- If a process is already alive, new messages pipe directly into it.
- On idle timeout (default 90s) or process exit, the exchange is recorded and compaction may run.

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH
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
snoot restart <channel> [options]
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
snoot mychannel --mode research --budget 2.00 --timeout 120

# Run in foreground (for debugging)
snoot mychannel --fg

# Override user for this project
snoot mychannel --user 05def456...
```

Run this from the project directory you want Claude to work on. Snoot daemonizes by default — it verifies startup, then detaches and logs to `.snoot/<channel>/snoot.log`.

### Stopping

```bash
# Stop a specific channel
snoot shutdown mychannel

# Stop all running instances in the current project
snoot shutdown
```

### Restarting

```bash
# Restart with new options
snoot restart mychannel --mode chat --budget 0.50
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--user <session-id>` | User's Session ID (overrides saved ID) | — |
| `--mode <mode>` | Tool mode: `chat`, `research`, or `coding` | `coding` |
| `--timeout <seconds>` | Idle timeout before killing Claude process | `90` |
| `--budget <usd>` | Max budget per Claude process in USD | `1.00` |
| `--compact-at <n>` | Trigger compaction at N message pairs | `20` |
| `--window <n>` | Keep N pairs after compaction | `15` |
| `--fg` | Run in foreground instead of daemonizing | off |

### Modes

- **chat** — No tools. Claude can only respond with text.
- **research** — Read-only tools: Read, Grep, Glob, WebSearch, WebFetch.
- **coding** — Full tools: Read, Grep, Glob, Edit, Write, Bash, WebSearch, WebFetch.

## Session Commands

Send these from your phone in the Session chat:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Show current state (mode, process status, message count) |
| `/context` | Show summary and pinned items |
| `/mode <mode>` | Switch mode (chat/research/coding) |
| `/pin <text>` | Pin context that survives compaction |
| `/unpin <id>` | Remove a pinned item |
| `/compact` | Force context compaction now |
| `/forget` or `/clear` | Clear all context and start fresh |

## Context Management

Snoot manages conversation context across ephemeral Claude processes:

- **Recent messages** are kept in a sliding window (`recent.jsonl`)
- **Compaction** runs automatically when the window hits the threshold — older messages are summarized by a fast model (Haiku) and the window is trimmed
- **Pins** survive compaction, ensuring important context is never lost
- **Daily archives** (`archive/archive-YYYY-MM-DD.jsonl`) keep a full append-only history with 30-day retention
- **Summary** (`summary.md`) is a rolling compacted summary fed to each new Claude process

All state lives in `.snoot/<channel>/` within your project directory.

## Project Structure

```
src/
├── index.ts      # CLI entry point, arg parsing, PID lock
├── proxy.ts      # Core orchestration
├── claude.ts     # Claude process lifecycle, stream-json I/O
├── context.ts    # Context store, compaction, prompt building
├── session.ts    # Session client, message chunking
├── commands.ts   # /slash command handler
└── types.ts      # Shared types and interfaces
```

## License

Private.
