import { describe, expect, it } from 'vitest';
import type { Browser } from 'wxt/browser';
import { LIMITS } from './constants';
import { auditSelection, dedupeEligibilityReason, firstExclusionReason, selectCandidates } from './selection';

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

describe('firstExclusionReason', () => {
  it('reports the first matching rule in filter-chain order', () => {
    expect(firstExclusionReason(tab({ id: 1 }))).toBeNull();
    expect(firstExclusionReason(tab({ id: null as unknown as number, pinned: true }))).toBe('no-id');
    expect(firstExclusionReason(tab({ id: 2, pinned: true, groupId: 5 }))).toBe('pinned');
    expect(firstExclusionReason(tab({ id: 3, groupId: 5, url: '' }))).toBe('grouped');
    expect(firstExclusionReason(tab({ id: 4, url: '' }))).toBe('no-url');
    expect(firstExclusionReason(tab({ id: 5, url: 'chrome://newtab/' }))).toBe('internal-url');
    expect(firstExclusionReason(tab({ id: 6, url: 'vivaldi://policy/' }))).toBe('internal-url');
  });
});

describe('dedupeEligibilityReason', () => {
  it('ignores the grouped rule only when asked (Vivaldi exception)', () => {
    const grouped = tab({ id: 1, groupId: 5, url: 'https://a.com/x' });
    expect(dedupeEligibilityReason(grouped, true)).toBeNull();
    expect(dedupeEligibilityReason(grouped, false)).toBe('grouped');
    // Other rules still apply on Vivaldi.
    expect(dedupeEligibilityReason(tab({ id: 2, pinned: true, url: 'https://a.com/x' }), true)).toBe('pinned');
    expect(dedupeEligibilityReason(tab({ id: 3, url: 'chrome://newtab/' }), true)).toBe('internal-url');
  });
});

describe('auditSelection', () => {
  it('marks every read tab as selected or excluded with the rule that dropped it', () => {
    const audit = auditSelection([
      tab({ id: 1, url: 'https://a.com/' }),
      tab({ id: 2, groupId: 7, url: 'https://b.com/' }),
      tab({ id: 3, pinned: true }),
      tab({ id: 4, url: 'chrome://settings/' }),
    ]);
    expect(audit.candidates.map((t) => t.id)).toEqual([1]);
    expect(audit.tabs).toHaveLength(4);
    const byId = new Map(audit.tabs.map((t) => [t.id, t]));
    expect(byId.get(1)).toMatchObject({ selected: true });
    expect(byId.get(2)).toMatchObject({ selected: false, reason: 'grouped', groupId: 7 });
    expect(byId.get(3)).toMatchObject({ selected: false, reason: 'pinned' });
    expect(byId.get(4)).toMatchObject({ selected: false, reason: 'internal-url', url: 'chrome://settings/' });
  });

  it('marks rule-passing tabs beyond the maxTabs cap as over-cap, oldest first', () => {
    const tabs = Array.from({ length: LIMITS.maxTabs + 2 }, (_, i) => tab({ id: i + 1, lastAccessed: i }));
    const audit = auditSelection(tabs);
    expect(audit.candidates).toHaveLength(LIMITS.maxTabs);
    const dropped = audit.tabs.filter((t) => t.reason === 'over-cap');
    expect(dropped.map((t) => t.id)).toEqual([1, 2]);
    expect(dropped[0]?.lastAccessed).toBe(0);
  });

  it('never disagrees with selectCandidates', () => {
    const tabs = [
      tab({ id: 1, pinned: true }),
      tab({ id: 2, url: 'https://x.com/' }),
      tab({ id: 3, groupId: 1 }),
      tab({ id: 4, url: 'about:blank' }),
    ];
    const audit = auditSelection(tabs);
    expect(audit.candidates).toEqual(selectCandidates(tabs));
    expect(audit.tabs.filter((t) => t.selected)).toHaveLength(audit.candidates.length);
  });
});
