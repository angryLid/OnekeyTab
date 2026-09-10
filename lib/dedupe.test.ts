import { describe, expect, it } from 'vitest';
import type { Browser } from 'wxt/browser';
import { DEDUPE } from './constants';
import { normalizeUrl, pairScore, planDedupe, segmentDistance } from './dedupe';
import { isVivaldi, isVivaldiFromNav } from './vivaldi';

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

describe('isVivaldi', () => {
  it('detects Vivaldi in the UA-CH brand list, case-insensitively', () => {
    expect(isVivaldiFromNav({ userAgentData: { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Vivaldi', version: '8' }] } })).toBe(true);
    expect(isVivaldiFromNav({ userAgentData: { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'NotA_Brand', version: '24' }] }, userAgent: 'Chrome/140' })).toBe(false);
  });

  it('checks the UA string even when the brand list is masked (no short-circuit)', () => {
    expect(isVivaldiFromNav({ userAgentData: { brands: [{ brand: 'Chromium', version: '140' }] }, userAgent: 'Chrome/140 Safari/537.36 Vivaldi/8.2' })).toBe(true);
    expect(isVivaldiFromNav({ userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/139.0' })).toBe(false);
  });

  it('detects Vivaldi from the vivExtData tab-object signal, immune to UA masking', () => {
    expect(isVivaldi([{ vivExtData: { workspaceId: 1 } }], { userAgent: 'Chrome/140' })).toBe(true);
    expect(isVivaldi([{ exData: {} }], { userAgent: 'Chrome/140' })).toBe(true);
    expect(isVivaldi([{ id: 1, url: 'https://a.com/' }], { userAgent: 'Chrome/140' })).toBe(false);
  });
});

const THRESHOLD = DEDUPE.threshold;

describe('normalizeUrl', () => {
  it('lowercases the host, drops the scheme, and splits path segments', () => {
    const n = normalizeUrl('https://Example.com/A/B/');
    expect(n?.host).toBe('example.com');
    expect(n?.segments).toEqual(['A', 'B']);
    expect(n?.params.size).toBe(0);
  });

  it('strips tracking params but keeps the rest', () => {
    const n = normalizeUrl('https://a.com/x?utm_source=t.co&keep=1&fbclid=zzz');
    expect(n?.params).toEqual(new Map([['keep', '1']]));
  });

  it('matches tracking keys case-insensitively', () => {
    const n = normalizeUrl('https://a.com/x?UTM_Source=t.co');
    expect(n?.params.size).toBe(0);
  });

  it('folds a non-empty fragment in as one trailing segment', () => {
    expect(normalizeUrl('https://app.com/dashboard#/settings')?.segments).toEqual(['dashboard', 'settings']);
    expect(normalizeUrl('https://mail.google.com/mail/u/0/#inbox')?.segments).toEqual(['mail', 'u', '0', 'inbox']);
  });

  it('returns null for unparseable URLs', () => {
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('segmentDistance', () => {
  it('charges 1 for insert/delete and 2 for substitution', () => {
    expect(segmentDistance(['A', 'B', 'C'], ['A', 'B'])).toBe(1);
    expect(segmentDistance(['A', 'B'], ['A', 'B', 'C', 'D'])).toBe(2);
    expect(segmentDistance(['A', 'B'], ['A', 'C'])).toBe(2);
    expect(segmentDistance([], [])).toBe(0);
    expect(segmentDistance(['x'], [])).toBe(1);
  });
});

describe('pairScore — the blessed verdict table from the design session', () => {
  const cases: Array<{ a: string; b: string; score: number; close: boolean }> = [
    { a: 'https://a.com/articles/ai', b: 'https://a.com/articles/ai?utm_source=t.co', score: 1, close: true },
    { a: 'https://a.com/articles/ai', b: 'https://a.com/articles/ai/', score: 1, close: true },
    { a: 'https://mail.google.com/mail/u/0/#inbox', b: 'https://mail.google.com/mail/u/0/#inbox', score: 1, close: true },
    { a: 'https://a.com/x?b=2&a=1', b: 'https://a.com/x?a=1&b=2', score: 1, close: true },
    { a: 'http://a.com/x', b: 'https://a.com/x', score: 1, close: true },
    { a: 'https://a.com/x', b: 'https://a.com/x?a=1&b=2&c=3', score: 0.7, close: false },
    { a: 'https://domain.com/A/B/C', b: 'https://domain.com/A/B/', score: 0.7667, close: true },
    { a: 'https://forum.com/t/123?page=2', b: 'https://forum.com/t/123?page=7', score: 0.7, close: false },
    { a: 'https://news.ycombinator.com/item?id=111', b: 'https://news.ycombinator.com/item?id=222', score: 0.7, close: false },
    { a: 'https://a.com/x?tab=grid', b: 'https://a.com/x?tab=list', score: 0.7, close: false },
    { a: 'https://docs.google.com/document/d/AAA/edit', b: 'https://docs.google.com/document/d/BBB/edit', score: 0.65, close: false },
    { a: 'https://en.wikipedia.org/wiki/Cat', b: 'https://en.wikipedia.org/wiki/Dog', score: 0.3, close: false },
    { a: 'https://github.com/vercel/next.js', b: 'https://github.com/vercel/turborepo', score: 0.3, close: false },
    { a: 'https://app.com/dashboard#/settings', b: 'https://app.com/dashboard#/profile', score: 0.3, close: false },
    { a: 'https://a.com/', b: 'https://a.com/x', score: 0.3, close: false },
    { a: 'https://a.com/x', b: 'https://b.com/x', score: 0, close: false },
  ];
  for (const [i, c] of cases.entries()) {
    it(`case ${i + 1}: ${c.a} vs ${c.b} -> ${c.close ? 'close' : 'keep'}`, () => {
      const a = normalizeUrl(c.a)!;
      const b = normalizeUrl(c.b)!;
      expect(pairScore(a, b)).toBeCloseTo(c.score, 3);
      expect(pairScore(a, b) >= THRESHOLD).toBe(c.close);
    });
  }
});

describe('planDedupe', () => {
  it('closes each family member older than the surviving anchor', () => {
    const plan = planDedupe(
      [
        tab({ id: 1, lastAccessed: 300, url: 'https://a.com/A/B/C' }),
        tab({ id: 2, lastAccessed: 200, url: 'https://a.com/A/B/' }),
        tab({ id: 3, lastAccessed: 100, url: 'https://b.com/x' }),
        tab({ id: 4, lastAccessed: 50, url: 'https://b.com/y' }),
      ],
      THRESHOLD,
    );
    expect(plan.closedIds).toEqual([2]);
    expect(plan.entries.map((e) => e.role)).toEqual(['baseline', 'closed', 'baseline', 'baseline']);
    expect(plan.entries[1]).toMatchObject({ score: 0.767, baselineId: 1 });
  });

  it('breaks lastAccessed ties by ascending tab id, deterministically', () => {
    const plan = planDedupe(
      [
        tab({ id: 5, lastAccessed: 100, url: 'https://a.com/x' }),
        tab({ id: 3, lastAccessed: 100, url: 'https://b.com/x' }),
      ],
      THRESHOLD,
    );
    expect(plan.entries[0]?.tabId).toBe(3);
    expect(plan.entries[0]?.role).toBe('baseline');
  });

  it('ignores unparseable URLs without ever promoting them to baseline', () => {
    const plan = planDedupe(
      [
        tab({ id: 1, lastAccessed: 300, url: 'not a url' }),
        tab({ id: 2, lastAccessed: 200, url: 'https://a.com/x' }),
        tab({ id: 3, lastAccessed: 100, url: 'https://a.com/x/' }),
      ],
      THRESHOLD,
    );
    expect(plan.entries[0]?.role).toBe('ignored');
    expect(plan.entries[1]?.role).toBe('baseline');
    expect(plan.closedIds).toEqual([3]);
  });

  it('closes a whole chain of exact duplicates against the newest anchor', () => {
    const plan = planDedupe(
      [
        tab({ id: 1, lastAccessed: 300, url: 'https://mail.google.com/mail/u/0/#inbox' }),
        tab({ id: 2, lastAccessed: 200, url: 'https://mail.google.com/mail/u/0/#inbox' }),
        tab({ id: 3, lastAccessed: 100, url: 'https://mail.google.com/mail/u/0/#inbox' }),
      ],
      THRESHOLD,
    );
    expect(plan.closedIds).toEqual([2, 3]);
    expect(plan.entries.every((e) => e.role === 'baseline' || e.score === 1)).toBe(true);
  });

  it('respects the threshold parameter', () => {
    const tabs = [
      tab({ id: 1, lastAccessed: 200, url: 'https://en.wikipedia.org/wiki/Cat' }),
      tab({ id: 2, lastAccessed: 100, url: 'https://en.wikipedia.org/wiki/Dog' }),
    ];
    expect(planDedupe(tabs, THRESHOLD).closedIds).toEqual([]);
    expect(planDedupe(tabs, 0.3).closedIds).toEqual([2]);
  });

  it('keeps scores of closed tabs within [0, 1] and rounded for logging', () => {
    const plan = planDedupe(
      [
        tab({ id: 1, lastAccessed: 200, url: 'https://a.com/A/B/C' }),
        tab({ id: 2, lastAccessed: 100, url: 'https://a.com/A/B/' }),
      ],
      THRESHOLD,
    );
    const closed = plan.entries.find((e) => e.role === 'closed');
    expect(closed?.score).toBeCloseTo(0.7667, 3);
  });
});
