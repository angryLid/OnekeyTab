import type { Browser } from 'wxt/browser';
import { LIMITS } from './constants';
import type { ModelTab } from './types';

/** origin + pathname with query/hash stripped; tolerates opaque origins (about:) and junk. */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.origin && url.origin !== 'null') return url.origin + url.pathname;
    return url.protocol + (url.host ? `//${url.host}` : '') + url.pathname;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

export function toModelTab(tab: Browser.tabs.Tab): ModelTab {
  return {
    id: tab.id as number,
    title: (tab.title ?? '').slice(0, LIMITS.titleMax),
    url: sanitizeUrl(tab.url as string),
  };
}

export function toModelTabs(tabs: Browser.tabs.Tab[]): ModelTab[] {
  return tabs.map(toModelTab);
}
