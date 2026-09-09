export type ProviderId = 'openrouter';

export interface Config {
  provider: ProviderId;
  apiKey: string;
}

export interface ModelTab {
  id: number;
  title: string;
  url: string;
}

export interface GroupPlan {
  name: string;
  tabIds: number[];
}

export interface LastError {
  message: string;
  timestamp: number;
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ChatResult {
  content: string;
  model: string;
}

export interface ParseResult {
  plans: GroupPlan[];
  errors: string[];
}

export interface ApplyReport {
  applied: number;
  skipped: number;
  failed: number;
  failures: string[];
}

// ---- Run log ----

export type RunOutcome = 'success' | 'skip' | 'error';

export interface RunCall {
  /** When the request was fired. */
  ts: number;
  /** Wall-clock time for this single call. */
  durationMs: number;
  /** Model id reported back by the provider (auto-routed free model). */
  model: string;
  /** Full request messages sent (system prompt + candidates). */
  request: ChatMessage[];
  /** Full raw response content. */
  response: string;
  /** Present when this call's response failed to parse (led to retry). */
  parseError?: string;
}

export interface RunRecord {
  id: string;
  ts: number;
  outcome: RunOutcome;
  /** Whole-run wall-clock time. */
  durationMs: number;
  windowId?: number;
  /** Number of candidate tabs fed to the model. */
  tabCount?: number;
  /** For skip/error runs without an LLM call: why we did not call. */
  reason?: string;
  /** For error runs: the surfaced error message. */
  error?: string;
  /** One per LLM call; absent when the model was never reached. */
  calls?: RunCall[];
}

/** Lightweight projection stored in the index; a full record is read on demand. */
export interface RunIndexEntry {
  id: string;
  ts: number;
  outcome: RunOutcome;
  durationMs: number;
  tabCount?: number;
  model?: string;
  error?: string;
  /** Estimated serialized byte size of the full record, used for the cap. */
  bytes: number;
}

export interface LogIndex {
  /** Oldest-first. */
  entries: RunIndexEntry[];
  /** Total estimated serialized bytes of all kept records. */
  totalBytes: number;
}
