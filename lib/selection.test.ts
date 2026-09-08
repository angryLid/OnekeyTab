import { describe, expect, it } from 'vitest';
import type { Browser } from 'wxt/browser';
import { selectCandidates } from './selection';

function tab(overrides: Partial<Browser.tabs.Tab> & { id: number }): Browser.tabs.Tab {
  return {
    pinned: false,
    groupId: -1,
    lastAccessed: 0,
    url: 'https://example.com/',
    title: 'Example',
    ...overrides,
  } as Browser.tabs.Tab;
}

describe('selectCandidates (happy path)', () => {
  it('keeps normal tabs and drops grouped, pinned, and internal-scheme tabs', () => {
    const tabs = [
      tab({ id: 1, url: 'https://news.ycombinator.com/' }),
      tab({ id: 2, groupId: 7, url: 'https://github.com/' }),
      tab({ id: 3, pinned: true, url: 'https://mail.google.com/' }),
      tab({ id: 4, url: 'about:blank' }),
      tab({ id: 5, url: 'chrome://settings/' }),
      tab({ id: 6, url: 'moz-extension://abc/popup.html' }),
      tab({ id: 7, url: 'chrome-extension://abc/index.html' }),
      tab({ id: 8, url: 'edge://flags/' }),
      tab({ id: 9, url: '' }),
    ];
    const result = selectCandidates(tabs);
    expect(result.map((t) => t.id)).toEqual([1]);
  });

  it('sorts by lastAccessed descending', () => {
    const tabs = [
      tab({ id: 1, lastAccessed: 100 }),
      tab({ id: 2, lastAccessed: 300 }),
      tab({ id: 3, lastAccessed: 200 }),
    ];
    expect(selectCandidates(tabs).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it('caps the result at 50 tabs', () => {
    const tabs = Array.from({ length: 60 }, (_, i) => tab({ id: i + 1, lastAccessed: i }));
    const result = selectCandidates(tabs);
    expect(result).toHaveLength(50);
    expect(result[0]?.id).toBe(60);
  });
});
