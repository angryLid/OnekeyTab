import type { Browser } from 'wxt/browser';
import { LIMITS } from './constants';
import type { ModelTab } from './types';

export function toModelTab(tab: Browser.tabs.Tab): ModelTab {
  const url = new URL(tab.url as string);
  return {
    id: tab.id as number,
    title: (tab.title ?? '').slice(0, LIMITS.titleMax),
    url: url.origin + url.pathname,
  };
}

export function toModelTabs(tabs: Browser.tabs.Tab[]): ModelTab[] {
  return tabs.map(toModelTab);
}
