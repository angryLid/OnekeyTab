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
    model: 'openrouter/free',
    extraHeaders: { 'X-Title': 'AI Tab Grouper' },
  },
};

export const LIMITS = {
  maxTabs: 50,
  minCandidates: 3,
  titleMax: 200,
  nameMax: 24,
  timeoutMs: 60_000,
  maxTokens: 2000,
  temperature: 0.2,
  skipBadgeMs: 2000,
} as const;

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

export const BADGE_COLORS = {
  pending: '#808080',
  error: '#d93025',
  skip: '#34a853',
} as const;

export const LOG = {
  indexKey: 'ai-tab-grouper:logIndex',
  /** Upper cap on stored run logs, well inside Chrome's default 10MB storage.local quota. */
  maxTotalBytes: 5 * 1024 * 1024,
  /** How many recent records the UI renders / exports by default. */
  listWindow: 100,
  /** Prefix for per-run payload keys. */
  runKeyPrefix: 'ai-tab-grouper:run:',
} as const;
