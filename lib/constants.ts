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
