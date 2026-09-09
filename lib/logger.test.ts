import { describe, expect, it } from 'vitest';
import { LOG } from './constants';
import { appendToIndex, newRunId, removeFromIndex } from './logger';
import type { LogIndex, RunRecord, SelectionRecord } from './types';

function rec(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: newRunId(),
    ts: 0,
    outcome: 'success',
    durationMs: 1,
    calls: [],
    ...overrides,
  };
}

function bigRecord(extra: string): RunRecord {
  return { ...rec(), calls: [{ ts: 0, durationMs: 1, model: 'm', request: [], response: 'x'.repeat(extra.length * 100) }] };
}

describe('newRunId', () => {
  it('generates unique ids', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
  });
});

describe('appendToIndex', () => {
  it('appends newest last and keeps totalBytes as the sum of entry bytes', () => {
    const index: LogIndex = { entries: [], totalBytes: 0 };
    const r1 = rec();
    const r2 = rec();
    const i1 = appendToIndex(index, r1, 1_000_000);
    const i2 = appendToIndex(i1, r2, 1_000_000);
    expect(i2.entries.map((e) => e.id)).toEqual([r1.id, r2.id]);
    expect(i2.totalBytes).toBe(i2.entries.reduce((s, e) => s + e.bytes, 0));
  });

  it('evicts oldest while over the cap, keeping the newest', () => {
    const a = bigRecord('aaa'.repeat(30)); // ~9000+ bytes
    const b = bigRecord('bbb'.repeat(30));
    const c = bigRecord('ccc'.repeat(30));
    const d = bigRecord('ddd'.repeat(30));
    let index: LogIndex = { entries: [], totalBytes: 0 };
    index = appendToIndex(index, a, 1_000_000);
    index = appendToIndex(index, b, 1_000_000);
    index = appendToIndex(index, c, 1_000_000);
    // Cap allowing only the two newest (c + d) to fit.
    const twoNewestBytes = appendToIndex({ entries: [], totalBytes: 0 }, c, 1_000_000).totalBytes +
      appendToIndex({ entries: [], totalBytes: 0 }, d, 1_000_000).totalBytes;
    const capped = appendToIndex(index, d, twoNewestBytes);
    expect(capped.entries.map((e) => e.id)).toEqual([c.id, d.id]);
    expect(capped.totalBytes).toBe(capped.entries.reduce((s, e) => s + e.bytes, 0));
  });

  it('keeps a single oversized record rather than dropping the latest run', () => {
    const a = bigRecord('x'.repeat(200)); // large
    const index = appendToIndex({ entries: [], totalBytes: 0 }, a, 10);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]!.id).toBe(a.id);
  });
});

function selRec(overrides: Partial<SelectionRecord> = {}): SelectionRecord {
  return {
    id: newRunId(),
    ts: 0,
    windowId: 1,
    tabs: [
      { id: 1, title: 'A', pinned: false, selected: true },
      { id: 2, title: 'B', pinned: true, selected: false, reason: 'pinned' },
    ],
    totalTabs: 2,
    selectedCount: 1,
    excludedCount: 1,
    ...overrides,
  };
}

describe('appendToIndex (selection records)', () => {
  it('projects a selection record into a selection entry with counts', () => {
    const index = appendToIndex({ entries: [], totalBytes: 0 }, selRec(), 1_000_000);
    expect(index.entries).toHaveLength(1);
    const e = index.entries[0]!;
    expect(e.kind).toBe('selection');
    expect(e.outcome).toBe('success');
    expect(e.tabCount).toBe(2);
    expect(e.excludedCount).toBe(1);
    expect(e.bytes).toBe(JSON.stringify(selRec()).length);
  });

  it('projects run records with kind "run" and run fields', () => {
    const index = appendToIndex({ entries: [], totalBytes: 0 }, rec(), 1_000_000);
    const e = index.entries[0]!;
    expect(e.kind).toBe('run');
    expect(e.outcome).toBe('success');
    expect(e.excludedCount).toBeUndefined();
  });

  it('applies the shared byte cap across kinds, evicting oldest regardless of kind', () => {
    let index: LogIndex = { entries: [], totalBytes: 0 };
    const selection = selRec();
    const run = bigRecord('x'.repeat(50));
    index = appendToIndex(index, selection, 1_000_000);
    index = appendToIndex(index, run, 1_000_000);
    const onlyRunBytes = appendToIndex({ entries: [], totalBytes: 0 }, run, 1_000_000).totalBytes;
    const capped = appendToIndex(index, bigRecord('y'.repeat(50)), onlyRunBytes);
    expect(capped.entries.map((e) => e.id)).not.toContain(selection.id);
    expect(capped.totalBytes).toBe(capped.entries.reduce((s, e) => s + e.bytes, 0));
  });
});

describe('removeFromIndex', () => {
  it('removes an entry and adjusts totalBytes exactly', () => {
    const a = bigRecord('a'.repeat(20));
    const b = bigRecord('b'.repeat(20));
    let index: LogIndex = { entries: [], totalBytes: 0 };
    index = appendToIndex(index, a, 1_000_000);
    index = appendToIndex(index, b, 1_000_000);
    const before = index.totalBytes;
    const removedA = index.entries.find((e) => e.id === a.id)!;
    const next = removeFromIndex(index, a.id);
    expect(next.entries.map((e) => e.id)).toEqual([b.id]);
    expect(next.totalBytes).toBe(before - removedA.bytes);
  });

  it('is a no-op for an unknown id (zero bytes subtracted)', () => {
    const a = bigRecord('a'.repeat(20));
    let index: LogIndex = { entries: [], totalBytes: 0 };
    index = appendToIndex(index, a, 1_000_000);
    const next = removeFromIndex(index, 'nope');
    expect(next.entries).toHaveLength(1);
    expect(next.totalBytes).toBe(index.totalBytes);
  });
});

it('LOG.maxTotalBytes is within the default storage.local quota', () => {
  // Chrome's default storage.local quota is ~10MB; keep a clear margin.
  expect(LOG.maxTotalBytes).toBeLessThan(10 * 1024 * 1024);
});
