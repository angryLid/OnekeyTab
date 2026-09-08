import { describe, expect, it } from 'vitest';
import type { Browser } from 'wxt/browser';
import { toModelTab, toModelTabs } from './model-input';

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

describe('toModelTab (happy path)', () => {
  it('maps id, title, and origin+path without query or hash', () => {
    const result = toModelTab(
      tab({ id: 42, title: 'Repo', url: 'https://github.com/a/b?token=secret#readme' }),
    );
    expect(result).toEqual({ id: 42, title: 'Repo', url: 'https://github.com/a/b' });
  });

  it('truncates titles to 200 characters', () => {
    const result = toModelTab(tab({ id: 1, title: 'x'.repeat(500) }));
    expect(result.title).toHaveLength(200);
  });

  it('maps all tabs', () => {
    const result = toModelTabs([tab({ id: 1, url: 'https://a.com/p?q=1' }), tab({ id: 2 })]);
    expect(result.map((t) => t.url)).toEqual(['https://a.com/p', 'https://example.com/']);
  });
});
