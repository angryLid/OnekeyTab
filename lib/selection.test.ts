import { describe, expect, it } from 'vitest';
import type { Browser } from 'wxt/browser';
import { LIMITS } from './constants';
import {
  auditSelection,
  dedupeEligibilityReason,
  defaultSelectionContext,
  exclusionReason,
  firstExclusionReason,
  selectCandidates,
  selectionContextFromGroups,
} from './selection';
import type { GroupInfo } from './types';

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

/** Bridge-port context: stack membership from listGroups, native groupIds untrusted. */
function bridgeContext(groups: GroupInfo[]): ReturnType<typeof selectionContextFromGroups> {
  return selectionContextFromGroups(groups, { visibleGroupReason: 'stacked', nativeGroupsTrustworthy: false });
}

function ctxFor(tabs: Browser.tabs.Tab[], stacks: Array<[number, string]> = []): ReturnType<typeof defaultSelectionContext> {
  const base = defaultSelectionContext(tabs);
  return { ...base, stacks: new Map([...base.stacks, ...stacks]) };
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

describe('exclusionReason with a bridge context', () => {
  it('excludes visible stack members before native grouped, and labels them stacked', () => {
    const ctx = bridgeContext([{ id: 's-1', name: 'Research', tabIds: [7, 8] }]);
    // A stack member with a leftover invisible native groupId is still stacked, never grouped.
    expect(exclusionReason(tab({ id: 7, groupId: 5, url: '' }), ctx)).toBe('stacked');
    expect(exclusionReason(tab({ id: 8, url: '' }), ctx)).toBe('stacked');
    expect(exclusionReason(tab({ id: 9 }), ctx)).toBeNull();
  });

  it('never gates candidacy on native groupIds when they are untrustworthy', () => {
    const ctx = bridgeContext([]);
    expect(exclusionReason(tab({ id: 1, groupId: 42 }), ctx)).toBeNull();
  });
});

describe('dedupeEligibilityReason', () => {
  it('ignores the grouped rule only when asked (Vivaldi exception)', () => {
    const grouped = tab({ id: 1, groupId: 5, url: 'https://a.com/x' });
    const ctx = defaultSelectionContext([grouped]);
    expect(dedupeEligibilityReason(grouped, ctx, true)).toBeNull();
    expect(dedupeEligibilityReason(grouped, ctx, false)).toBe('grouped');
    // Other rules still apply on Vivaldi.
    expect(dedupeEligibilityReason(tab({ id: 2, pinned: true, url: 'https://a.com/x' }), ctx, true)).toBe('pinned');
    expect(dedupeEligibilityReason(tab({ id: 3, url: 'chrome://newtab/' }), ctx, true)).toBe('internal-url');
  });

  it('never ignores the stacked rule: closing a duplicate would visibly shrink a stack', () => {
    const stacked = tab({ id: 4, groupId: 5 });
    const ctx = bridgeContext([{ id: 's-1', name: '', tabIds: [4] }]);
    expect(dedupeEligibilityReason(stacked, ctx, true)).toBe('stacked');
    expect(dedupeEligibilityReason(stacked, ctx, false)).toBe('stacked');
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

  it('under a bridge context, invisible groupIds re-enter candidacy while stack members stay excluded', () => {
    const tabs = [tab({ id: 1, groupId: 7 }), tab({ id: 2, groupId: 7 }), tab({ id: 3 })];
    const ctx = bridgeContext([{ id: 's-1', name: '', tabIds: [2] }]);
    const audit = auditSelection(tabs, ctx);
    expect(audit.candidates.map((t) => t.id)).toEqual([1, 3]);
    const byId = new Map(audit.tabs.map((t) => [t.id, t]));
    expect(byId.get(1)).toMatchObject({ selected: true, groupId: 7 });
    expect(byId.get(2)).toMatchObject({ selected: false, reason: 'stacked', stackId: 's-1' });
  });

  it('derives the Chrome-default context from raw groupIds when no context is passed', () => {
    const tabs = [tab({ id: 1, groupId: 7 }), tab({ id: 2 })];
    const ctx = defaultSelectionContext(tabs);
    expect(ctx.visibleGroupReason).toBe('grouped');
    expect(ctx.nativeGroupsTrustworthy).toBe(true);
    expect(ctx.stacks.get(1)).toBe('7');
    expect(auditSelection(tabs).tabs.map((t) => t.reason)).toEqual(['grouped', undefined]);
  });
});

describe('selectionContextFromGroups', () => {
  it('maps every member tab to its group id', () => {
    const ctx = selectionContextFromGroups(
      [
        { id: 'a', name: 'A', tabIds: [1, 2] },
        { id: 'b', name: '', tabIds: [3] },
      ],
      { visibleGroupReason: 'stacked', nativeGroupsTrustworthy: false },
    );
    expect(ctx.stacks.get(1)).toBe('a');
    expect(ctx.stacks.get(3)).toBe('b');
    expect(ctx.stacks.get(4)).toBeUndefined();
  });
});

describe('ctxFor helper parity', () => {
  it('merges explicit stack ids on top of the default context', () => {
    const tabs = [tab({ id: 1 }), tab({ id: 2, groupId: 9 })];
    const ctx = ctxFor(tabs, [[1, 'x-1']]);
    expect(ctx.stacks.get(1)).toBe('x-1');
    expect(ctx.stacks.get(2)).toBe('9');
  });
});
