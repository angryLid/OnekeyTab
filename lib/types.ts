export type ProviderId = 'openrouter';

export interface Config {
  provider: ProviderId;
  apiKey: string;
  /** Pre-group dedupe settings; absent in configs stored before the feature existed. */
  dedupe?: DedupeConfig;
  /** Grouping write backend; configs stored before the feature read as 'auto'. */
  groupingBackend?: GroupingBackend;
}

export interface DedupeConfig {
  enabled: boolean;
  threshold: number;
  /** Manual override for including already-grouped tabs; undefined = auto (on when Vivaldi is detected). */
  ignoreGrouped?: boolean;
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
  /** Which writer produced the report. */
  backend: EffectiveBackend;
}

// ---- Vivaldi stacks ----

export type GroupingBackend = 'auto' | 'native' | 'stacks';

/** Backend actually used for a run; 'auto' resolves to one of these before anything is written. */
export type EffectiveBackend = 'native' | 'stacks';

export type StackProbeReason = 'write-rejected' | 'error';

export interface StackProbeResult {
  supported: boolean;
  reason?: StackProbeReason;
  detail?: string;
}

/** Probe outcome as stored on a run record. */
export interface StackProbeRecord extends StackProbeResult {
  ts: number;
}

// ---- Logs (record kinds share one index and byte cap) ----

export type LogKind = 'run' | 'selection' | 'dedupe';

export type RunOutcome = 'success' | 'skip' | 'error';

/** Why a read tab was not offered to the model; the first matching rule wins. */
export type ExclusionReason = 'no-id' | 'pinned' | 'stacked' | 'grouped' | 'no-url' | 'internal-url' | 'over-cap';

/** One audited tab: what the extension read and whether a rule excluded it. */
export interface AuditTab {
  id: number | null;
  title: string;
  /** origin + pathname (query/hash stripped); absent when the tab had no URL. */
  url?: string;
  pinned: boolean;
  /** Present only for tabs that are in a group (> 0). */
  groupId?: number;
  /** Vivaldi stack id (vivExtData.group) when the tab is a visible stack member. */
  stackId?: string;
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
  /** Effective grouping backend for the click that produced this record. */
  backend?: EffectiveBackend;
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
  /** Id of the dedupe record from the same click, when the pre-pass ran. */
  dedupeId?: string;
  /** Backend that applied (or attempted to apply) the plan. */
  backend?: EffectiveBackend;
  /** Stack capability probe outcome, present whenever the stacks backend was considered. */
  stackProbe?: StackProbeRecord;
}

// ---- Dedupe ----

/** Scoring parameters snapshot stored per dedupe record so past decisions stay reproducible. */
export interface DedupeParams {
  threshold: number;
  weightPath: number;
  weightQuery: number;
  substituteCost: number;
  /** True when the `grouped` rule was skipped (Vivaldi, where native groups render nowhere). */
  ignoreGrouped?: boolean;
}

export type DedupeTabRole = 'baseline' | 'closed' | 'ignored';

export interface DedupeTabRecord {
  id: number;
  /** Full raw URL (including query and hash) so a closed tab can be recovered manually. */
  url: string;
  title: string;
  lastAccessed: number;
  role: DedupeTabRole;
  /** Similarity to its baseline; present for closed tabs. */
  score?: number;
  /** Tab id of the baseline it was compared against; present for closed tabs. */
  baselineId?: number;
  /** Backfilled after tabs.remove resolves, from a fresh window query. */
  outcome?: 'removed' | 'declined';
}

/** Dedupe record: which tabs the pre-pass compared, what it closed, and what actually died. */
export interface DedupeRecord {
  id: string;
  ts: number;
  windowId: number;
  params: DedupeParams;
  tabs: DedupeTabRecord[];
  plannedCloseCount: number;
  /** Backfilled after tabs.remove resolves; absent while only the plan is known. */
  closedCount?: number;
  /** Id of the run record from the same click, when one exists. */
  runId?: string;
}

/** Any record kind the log can store. */
export type AnyLogRecord = RunRecord | SelectionRecord | DedupeRecord;

/** Lightweight projection stored in the index; a full record is read on demand. */
export interface LogIndexEntry {
  id: string;
  kind: LogKind;
  ts: number;
  outcome: RunOutcome;
  durationMs: number;
  /** Run: model tabs. Selection: total tabs read. Dedupe: eligible tabs compared. */
  tabCount?: number;
  /** Selection only: how many of the read tabs were excluded. */
  excludedCount?: number;
  /** Dedupe only: tabs closed (planned at write time, backfilled to actual after removal). */
  closedCount?: number;
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
