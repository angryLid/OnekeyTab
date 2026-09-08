import { browser } from 'wxt/browser';
import type { Config, LastError } from './types';

const CONFIG_KEY = 'ai-tab-grouper:config';
const LAST_ERROR_KEY = 'ai-tab-grouper:lastError';

export async function getConfig(): Promise<Config | null> {
  const res = await browser.storage.local.get(CONFIG_KEY);
  return (res[CONFIG_KEY] as Config | undefined) ?? null;
}

export async function setConfig(config: Config): Promise<void> {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
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
