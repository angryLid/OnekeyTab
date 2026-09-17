import type { ProviderId } from './types';

export interface Provider {
  id: ProviderId;
  label: string;
  baseUrl: string;
  chatPath: string;
  model: string;
  extraHeaders: Record<string, string>;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    model: 'google/gemini-3.5-flash-lite',
    extraHeaders: { 'X-Title': 'Onekey Tab' },
  },
};

/** Console prefix shared by every module that logs. */
export const LOG_PREFIX = '[onekey-tab]';

export const LIMITS = {
  maxTabs: 100,
  minCandidates: 3,
  titleMax: 200,
  nameMax: 32,
  timeoutMs: 30_000,
  maxTokens: 4000,
  temperature: 0.2,
  skipBadgeMs: 2000,
} as const;

/** Longest accepted custom model id; OpenRouter ids fit comfortably under this. */
export const MODEL_ID_MAX = 120;

/** The effective model id: a non-empty configured override, or the built-in provider default. */
export function resolveModel(configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : PROVIDERS.openrouter.model;
}

/** True when the string is shaped like a model id (no whitespace, within the length cap). */
export function isValidModelId(value: string): boolean {
  return value.length > 0 && value.length <= MODEL_ID_MAX && !/\s/.test(value);
}

/** Longest accepted grouping policy text; generous for a policy, well inside any context window. */
export const PROMPT_MAX = 2000;

/** A built-in grouping policy the user can start from; the fixed system prompt never carries policy. */
export interface Prefill {
  id: string;
  label: string;
  text: string;
}

/**
 * Built-in grouping policies. The fixed system prompt only states the role and the output
 * contract, so each prefill owns the whole "how to group" strategy and must be self-contained.
 */
export const BUILT_IN_PREFILLS: Prefill[] = [
  {
    id: 'task-centric',
    label: 'Task-centric — tickets & MRs',
    text: [
      'You decide how the tabs are grouped. Goal: one group per work task, not per website.',
      '',
      'Tab URLs keep their paths; use them:',
      '- Work-item keys look like ABC-123 (project code, dash, number). Find them in URL paths (e.g. /browse/ABC-123) and in titles. They can live on any domain — never rely on the domain name.',
      '- GitLab-style pages carry a project path plus an artifact: /owner/project/-/merge_requests/42, /-/issues/42, /-/pipelines. MR and branch titles often quote the work-item key (e.g. "ABC-123 fix login").',
      '',
      'Procedure:',
      '1. Find every work-item key across all tabs. All tabs sharing one key — tickets, MRs, issues, diffs, pipelines — form one group, regardless of site.',
      '2. A keyless tab that clearly belongs to a project with a keyed group (repo pages, boards, backlog, MR lists) joins that group.',
      '3. Match a keyless project to a key only when the correspondence is evident (project name ≈ key prefix, or the key appears in titles). When unsure, keep them separate — a wrong merge is worse than a missed merge.',
      '4. Tabs with no task or project affinity stay ungrouped. Never create catch-all groups.',
      '',
      'Names: prefer "KEY-123 short-topic" in the ticket\'s own language, under 30 characters, same language as the tab titles; without a key, use the project name. A group needs at least 2 tabs; leave smaller clusters out. Create as many groups as there are real tasks — expect more groups when many tickets are open.',
    ].join('\n'),
  },
];

/** Look up a built-in prefill by id; unknown ids (removed from a later build) resolve to nothing. */
export function findPrefill(id?: string): Prefill | undefined {
  return BUILT_IN_PREFILLS.find((prefill) => prefill.id === id);
}

/**
 * Dedupe scoring constants. Structural tuning knobs, deliberately not user-facing:
 * only the toggle and the threshold are exposed in the settings UI.
 */
export const DEDUPE = {
  weightPath: 0.7,
  weightQuery: 0.3,
  insertDeleteCost: 1,
  substituteCost: 2,
  threshold: 0.75,
  minThreshold: 0.5,
  maxThreshold: 0.95,
  thresholdStep: 0.05,
  trackingParams: [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'utm_id',
    'fbclid',
    'gclid',
    'msclkid',
    'dclid',
    'spm',
    'scm',
    'igshid',
    'si',
    'share_source',
  ],
} as const;

export const BADGE = {
  pending: '…',
  error: '✗',
  skip: '✓',
} as const;

/** StackBridge protocol constants (Awesome-Vivaldi Bridge, envelope v2 — frozen upstream). */
export const BRIDGE = {
  /** Verified on a real Vivaldi 8.2 install; derived from a baked manifest key, so treat as configuration (Config.bridge.uiExtensionId). */
  defaultUiExtensionId: 'mpognobbkildjkofajifpdfhcoklimli',
  /** v2 adds the declarative layout.apply; the mod still serves every v1 action for rollback. */
  protocolVersion: 2,
  /** A missing mod fails fast; the timeout only bites when the mod hangs. */
  pingTimeoutMs: 3_000,
  requestTimeoutMs: 8_000,
  /** layout.apply orchestrates every group in one pass; generous ceiling for big windows. */
  layoutTimeoutMs: 30_000,
  /** Vivaldi's own fixed-title cap; longer plan names are truncated client-side so logs match reality. */
  nameMax: 50,
  installDocsUrl: 'https://github.com/angryLid/Awesome-Vivaldi/tree/main/Bridge',
} as const;

export const BADGE_COLORS = {
  pending: '#808080',
  error: '#d93025',
  skip: '#34a853',
} as const;

export const LOG = {
  indexKey: 'onekey-tab:logIndex',
  /** Upper cap on stored run logs, well inside Chrome's default 10MB storage.local quota. */
  maxTotalBytes: 5 * 1024 * 1024,
  /** How many recent records the UI renders / exports by default. */
  listWindow: 100,
  /** Prefix for per-run payload keys. */
  runKeyPrefix: 'onekey-tab:run:',
} as const;
