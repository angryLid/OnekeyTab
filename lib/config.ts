import { browser } from 'wxt/browser';
import { DEDUPE } from './constants';
import type { Config, DedupeConfig, LastError } from './types';

const CONFIG_KEY = 'ai-tab-grouper:config';
const LAST_ERROR_KEY = 'ai-tab-grouper:lastError';

const DEFAULT_DEDUPE: DedupeConfig = { enabled: true, threshold: DEDUPE.threshold };

export async function getConfig(): Promise<Config | null> {
  const res = await browser.storage.local.get(CONFIG_KEY);
  const raw = res[CONFIG_KEY] as Config | undefined;
  // Merge defaults so configs stored before a feature exists behave as if it were set up
  // (dedupe enabled, grouping backend auto).
  return raw ? { ...raw, dedupe: raw.dedupe ?? DEFAULT_DEDUPE, groupingBackend: raw.groupingBackend ?? 'auto' } : null;
}

export async function setConfig(config: Config): Promise<void> {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
}

/** Read-merge-write one config patch, preserving fields the caller does not mention; the single place that knows how a partial update is applied. */
export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const existing = await getConfig();
  const next: Config = { provider: 'openrouter', apiKey: '', ...existing, ...patch };
  await setConfig(next);
  return next;
}

export async function getLastError(): Promise<LastError | null> {
  const res = await browser.storage.local.get(LAST_ERROR_KEY);
  return (res[LAST_ERROR_KEY] as LastError | undefined) ?? null;
}

export async function setLastError(error: LastError): Promise<void> {
  await browser.storage.local.set({ [LAST_ERROR_KEY]: error });
}

export async function clearLastError(): Promise<void> {
  await browser.storage.local.remove(LAST_ERROR_KEY);
}
