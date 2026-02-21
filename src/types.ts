// -- Configuration --

export type Mode = "chat" | "research" | "coding";
export type Backend = "claude" | "gemini";

export interface Config {
  channel: string;
  userSessionId: string;
  mode: Mode;
  backend: Backend;
  budgetUsd?: number; // undefined = no budget limit
  compactAt: number; // trigger compaction when recent pairs exceed this
  windowSize: number; // keep this many pairs after compaction
  baseDir: string; // snoot data directory (.snoot/<channel>)
  workDir: string; // working directory for claude processes
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

export interface ContextState {
  nextId: number;
  totalPairs: number;
  pins: PinnedItem[];
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
  onExit(cb: () => void): void;
  onRateLimit(cb: (retryIn: number, attempt: number) => void): void;
  onApiError(cb: (retryIn: number, attempt: number, maxAttempts: number) => void): void;
  getStatus(): LLMStatus;
}

// Legacy aliases
export type ClaudeStatus = LLMStatus;
export type ClaudeManager = LLMManager;

// -- Session --

export interface SessionClient {
  startListening(onMessage: (text: string) => void): void;
  send(text: string): Promise<void>;
  setAvatar(png: Uint8Array): Promise<void>;
  getSessionId(): string;
}

// -- Commands --

export interface CommandResult {
  response: string;
  killProcess?: boolean;
  triggerCompaction?: boolean;
  restartProcess?: boolean;
}

// -- Context Store --

export interface ContextStore {
  load(): Promise<void>;
  append(pair: MessagePair): Promise<void>;
  buildPrompt(): string;
  needsCompaction(): boolean;
  compact(): Promise<void>;
  addPin(text: string): Promise<PinnedItem>;
  removePin(id: number): Promise<boolean>;
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
