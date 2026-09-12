export type ProviderId = 'openrouter';

export interface Config {
  /** Reserved: only 'openrouter' exists; llm.ts does not read this field yet. */
  provider: ProviderId;
  apiKey: string;
  /** Provider model id override; absent/empty = the built-in default in PROVIDERS. */
  model?: string;
  /** Pre-group dedupe settings; absent in configs stored before the feature existed. */
  dedupe?: DedupeConfig;
  /** Grouping write backend; configs stored before the feature read as 'auto'. */
  groupingBackend?: GroupingBackend;
  /** StackBridge endpoint settings; absent = built-in defaults. */
  bridge?: BridgeConfig;
}

export interface BridgeConfig {
  /** StackBridge endpoint override (the Vivaldi UI extension id); default lives in BRIDGE constants. */
  uiExtensionId?: string;
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

// ---- Grouping ports ----

export type GroupingBackend = 'auto' | 'native' | 'stacks';

/** True when a Chromium groupId does not denote a real group (absent, 0, or a negative sentinel). */
export function isUngroupedGroupId(groupId: number | null | undefined): boolean {
  return groupId == null || groupId <= 0;
}

/** Backend actually used for a run; 'auto' resolves to one of these before anything is written. */
export type EffectiveBackend = 'native' | 'stacks';

export type PortId = 'native' | 'vivaldi-bridge';

/** Declared per port; selection and dedupe consume caps instead of branching on the browser. */
export interface PortCaps {
  /** Informational: the browser renders the groups this port writes (true for both current ports). */
  visibleGroups: boolean;
  /** When false, native Chromium groupIds are invisible/stale state and never gate candidacy (Vivaldi). */
  nativeGroupsTrustworthy: boolean;
  /** Informational: hand-made groups are readable through listGroups (Bridge: yes via stacks.list; native: yes via groupIds). */
  userGroupsReadable: boolean;
  /** Exclusion label for visible-group membership: 'grouped' is config-droppable in dedupe, 'stacked' never. */
  visibleGroupReason: 'grouped' | 'stacked';
}

/** A visible group as the active port reports it; membership is the sole exclusion input. */
export interface GroupInfo {
  /** Port-native id (Chromium groupId as a string, or the Bridge stack id). */
  id: string;
  /** Display name; '' when unnamed — selection consumes membership, not names. */
  name: string;
  tabIds: number[];
}

export type PortProbeReason = 'no-listener' | 'timeout' | 'not-paired' | 'unsupported' | 'error';

export interface PortProbeResult {
  ok: boolean;
  reason?: PortProbeReason;
  detail?: string;
}

/** Probe outcome as stored on a run record. */
export interface PortProbeRecord extends PortProbeResult {
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
  /** Visible stack member per the active port (bridge stacks.list); set only when the exclusion reason is 'stacked'. */
  stackId?: string;
  /** Present only for over-cap exclusions, where recency decides. */
  lastAccessed?: number;
  selected: boolean;
  /** The rule that excluded this tab; absent when selected. */
  reason?: ExclusionReason;
}

/** Selection audit record: exactly which tabs were read and why each was kept or dropped. */
export interface SelectionRecord {
  kind: LogKind;
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
  kind: LogKind;
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
  /** Bridge probe outcome; present on Vivaldi runs only (native needs no probe). */
  probe?: PortProbeRecord;
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
  kind: LogKind;
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

/** Discriminate a record's kind; falls back to shape checks for records stored before the `kind` field existed. */
export function recordKind(record: AnyLogRecord): LogKind {
  if (record.kind) return record.kind;
  if ('selectedCount' in record) return 'selection';
  if ('plannedCloseCount' in record) return 'dedupe';
  return 'run';
}

export function isRunRecord(record: AnyLogRecord): record is RunRecord {
  return recordKind(record) === 'run';
}

export function isSelectionRecord(record: AnyLogRecord): record is SelectionRecord {
  return recordKind(record) === 'selection';
}

export function isDedupeRecord(record: AnyLogRecord): record is DedupeRecord {
  return recordKind(record) === 'dedupe';
}

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
