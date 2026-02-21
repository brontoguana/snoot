// -- Configuration --

export type Mode = "chat" | "research" | "coding";

export interface Config {
  channel: string;
  userSessionId: string;
  mode: Mode;
  idleTimeout: number; // seconds
  budgetUsd: number;
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

/** Input message sent to Claude via stdin */
export interface StreamJsonUserMessage {
  type: "user";
  message: { role: "user"; content: string };
}

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

// -- Claude process --

export interface ClaudeManager {
  isAlive(): boolean;
  send(text: string, promptFile?: string): void;
  waitForResponse(): Promise<string>;
  kill(): Promise<void>;
  onExit(cb: () => void): void;
}

// -- Session --

export interface SessionClient {
  startListening(onMessage: (text: string) => void): void;
  send(text: string): Promise<void>;
  getSessionId(): string;
}

// -- Commands --

export interface CommandResult {
  response: string;
  killProcess?: boolean;
  triggerCompaction?: boolean;
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
