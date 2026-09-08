import type { Browser } from 'wxt/browser';
import { LIMITS } from './constants';

const INTERNAL_SCHEMES = ['about:', 'chrome:', 'edge:', 'chrome-extension:', 'moz-extension:', 'extension:'];

function isInternalUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

function isUngrouped(tab: Browser.tabs.Tab): boolean {
  return tab.groupId == null || tab.groupId <= 0;
}

export function selectCandidates(tabs: Browser.tabs.Tab[]): Browser.tabs.Tab[] {
  return tabs
    .filter(
      (tab) =>
        tab.id != null &&
        !tab.pinned &&
        isUngrouped(tab) &&
        typeof tab.url === 'string' &&
        tab.url.length > 0 &&
        !isInternalUrl(tab.url),
    )
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, LIMITS.maxTabs);
}
