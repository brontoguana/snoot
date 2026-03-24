// -- Configuration --

export type Mode = "chat" | "research" | "coding";
export type Backend = string; // endpoint name (e.g. "claude", "gemini", "local")

export interface EndpointConfig {
  type: "cli" | "openai";
  cli?: string;      // for cli type: binary name ("claude" or "gemini")
  url?: string;      // for openai type: API base URL
  model?: string;    // for openai type: default model name
  apiKey?: string;   // for openai type: API key
}
export type Transport = "session" | "matrix";

export interface MatrixConfig {
  homeserver: string; // e.g. "https://matrix.org"
  accessToken?: string; // stored after login
  roomId?: string; // per-channel room ID (created/joined on first use)
}

export interface Config {
  channel: string;
  transport: Transport;
  userId: string; // transport-agnostic user ID (Session hex or Matrix @user:server)
  matrixConfig?: MatrixConfig; // present when transport === "matrix"
  mode: Mode;
  backend: Backend;
  model?: string; // model override (e.g. "opus", "sonnet", "gemini-2.5-pro")
  effort?: string; // effort level: "low", "medium", "high", "max" (Claude only)
  budgetUsd?: number; // undefined = no budget limit
  windowSize: number; // max message pairs in conversation history (default 20; compact when exceeded by 10)
  baseDir: string; // snoot data directory (.snoot/<channel>)
  workDir: string; // working directory for claude processes
  endpointConfig?: EndpointConfig; // resolved endpoint config for current backend
  cliPath?: string; // resolved full path to CLI binary (claude/gemini)
  selfCommand: string[]; // command to re-exec this process (for /restart)
}

// -- Context --

export interface MessagePair {
  id: number;
  user: string;
  assistant: string;
  timestamp: number;
  pinned?: boolean;
}

export interface PinnedItem {
  id: number;
  text: string;
  timestamp: number;
}

export interface RecentFile {
  path: string;
  ops: string[]; // e.g. ["read", "edit"]
  timestamp: number; // last accessed time
}

export interface RecentCommand {
  cmd: string;
  timestamp: number;
}

export interface ContextState {
  nextId: number;
  totalPairs: number;
  pins: PinnedItem[];
  recentFiles: RecentFile[];
  recentCommands: RecentCommand[];
}

// -- Claude stream-json protocol --

/** Output: assistant message with complete content */
export interface StreamJsonAssistantMessage {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: "text"; text: string } | { type: string; [key: string]: unknown }>;
  };
  session_id: string;
}

/** Output: final result message */
export interface StreamJsonResult {
  type: "result";
  result: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

/** Any NDJSON line from Claude stdout */
export type StreamJsonOutput =
  | StreamJsonAssistantMessage
  | StreamJsonResult
  | { type: string; [key: string]: unknown };

// -- LLM process --

export interface LLMStatus {
  alive: boolean;
  busy: boolean; // has pending response resolvers
  spawnedAt: number | null; // timestamp when process was spawned
  lastActivityAt: number | null; // timestamp of last stdout message
  backend: Backend;
}

export interface LLMManager {
  isAlive(): boolean;
  send(text: string, promptFile?: string): void;
  waitForResponse(): Promise<string>;
  kill(): Promise<void>;
  forceKill(): void; // synchronous SIGKILL — for use in SIGTERM handlers
  onExit(cb: () => void): void;
  onChunk(cb: (text: string) => void): void;
  onRateLimit(cb: (retryIn: number, attempt: number) => void): void;
  onApiError(cb: (retryIn: number, attempt: number, maxAttempts: number) => void): void;
  onActivity(cb: (line: string) => void): void;
  onToolUse(cb: (detail: string) => void): void;
  getStatus(): LLMStatus;
}

// Legacy aliases
export type ClaudeStatus = LLMStatus;
export type ClaudeManager = LLMManager;

// -- Transport --

export interface IncomingAttachment {
  id: string;
  contentType?: string;
  name?: string;
  size?: number;
  /** Raw transport-specific attachment for getFile() */
  _raw: unknown;
}

export interface IncomingMessage {
  text: string;
  attachments: IncomingAttachment[];
}

export interface TransportClient {
  startListening(onMessage: (msg: IncomingMessage) => void): Promise<void>;
  send(text: string): Promise<void>;
  sendImage(png: Uint8Array, caption?: string): Promise<void>;
  sendFile(filePath: string, caption?: string): Promise<void>;
  setAvatar(png: Uint8Array): Promise<void>;
  reuploadAvatar(): Promise<void>;
  getFile(attachment: IncomingAttachment): Promise<File>;
  getIdentity(): string; // Session ID or Matrix user ID
}

// Legacy alias
export type SessionClient = TransportClient;

// -- Commands --

export interface CommandResult {
  response: string;
  killProcess?: boolean;
  triggerCompaction?: boolean;
  restartProcess?: boolean;
  moveChannel?: string; // new channel name for /move — proxy handles restart with new name
  relocateDir?: string; // absolute path for /relocate — proxy handles move + restart
  saveWindow?: boolean; // persist windowSize to settings
}

// -- Context Store --

export interface ContextStore {
  load(): Promise<void>;
  append(pair: MessagePair): Promise<void>;
  buildPrompt(): string;
  needsCompaction(): boolean;
  compact(aggressive?: boolean): Promise<{ compacted: number; remaining: number } | null>;
  trackToolUse(detail: string): void;
  addPin(text: string): Promise<PinnedItem>;
  removePin(id: number): PinnedItem | null;
  getState(): ContextState;
  getRecent(): MessagePair[];
  getSummary(): string;
  reset(): Promise<void>;
  nextPairId(): number;
}

// -- Tools per mode --

export const TOOLS_BY_MODE: Record<Mode, string> = {
  chat: "",
  research: "Read,Grep,Glob,WebSearch,WebFetch",
  coding: "Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch",
};
