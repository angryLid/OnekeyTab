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

// ---- Logs (two record kinds share one index and byte cap) ----

export type LogKind = 'run' | 'selection';

export type RunOutcome = 'success' | 'skip' | 'error';

/** Why a read tab was not offered to the model; the first matching rule wins. */
export type ExclusionReason = 'no-id' | 'pinned' | 'grouped' | 'no-url' | 'internal-url' | 'over-cap';

/** One audited tab: what the extension read and whether a rule excluded it. */
export interface AuditTab {
  id: number | null;
  title: string;
  /** origin + pathname (query/hash stripped); absent when the tab had no URL. */
  url?: string;
  pinned: boolean;
  /** Present only for tabs that are in a group (> 0). */
  groupId?: number;
  /** Present only for over-cap exclusions, where recency decides. */
  lastAccessed?: number;
  selected: boolean;
  /** The rule that excluded this tab; absent when selected. */
  reason?: ExclusionReason;
}

/** Selection audit record: exactly which tabs were read and why each was kept or dropped. */
export interface SelectionRecord {
  id: string;
  ts: number;
  windowId: number;
  /** All tabs `tabs.query({ windowId })` returned, in query order. */
  tabs: AuditTab[];
  totalTabs: number;
  selectedCount: number;
  excludedCount: number;
  /** Id of the run record from the same click, when one exists. */
  runId?: string;
}

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
  /** Id of the selection audit record from the same click. */
  selectionId?: string;
}

/** Lightweight projection stored in the index; a full record is read on demand. */
export interface LogIndexEntry {
  id: string;
  kind: LogKind;
  ts: number;
  outcome: RunOutcome;
  durationMs: number;
  /** Run: model tabs. Selection: total tabs read. */
  tabCount?: number;
  /** Selection only: how many of the read tabs were excluded. */
  excludedCount?: number;
  model?: string;
  error?: string;
  /** Estimated serialized byte size of the full record, used for the cap. */
  bytes: number;
}

/** @deprecated Legacy name; use LogIndexEntry. */
export type RunIndexEntry = LogIndexEntry;

export interface LogIndex {
  /** Oldest-first. */
  entries: LogIndexEntry[];
  /** Total estimated serialized bytes of all kept records. */
  totalBytes: number;
}
