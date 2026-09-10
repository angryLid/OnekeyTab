import type { Browser } from 'wxt/browser';
import { DEDUPE } from './constants';

/** A URL reduced to its comparable identity: host, path segments (fragment folded in), normalized query params. */
export interface NormalizedUrl {
  host: string;
  segments: string[];
  params: Map<string, string>;
}

/**
 * Reduce a raw tab URL for comparison: lowercase host (ports ignored entirely), scheme dropped,
 * path split into non-empty segments, a non-empty fragment folded in as one trailing segment,
 * tracking params stripped, remaining query params compared order-insensitively.
 * Returns null when the URL cannot be parsed — such tabs are ignored by dedupe, never closed.
 */
export function normalizeUrl(raw: string): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (url.hash.length > 1) segments.push(url.hash.slice(1).replace(/^\/+/, ''));
  const tracking = new Set<string>(DEDUPE.trackingParams);
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (tracking.has(key.toLowerCase())) continue;
    params.set(key, value);
  }
  return { host: url.hostname.toLowerCase(), segments, params };
}

/** Weighted edit distance over path segments: insert/delete cost 1, substitute cost 2. Pure. */
export function segmentDistance(a: string[], b: string[]): number {
  const insDel = DEDUPE.insertDeleteCost;
  const sub = DEDUPE.substituteCost;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j * insDel;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i * insDel;
    for (let j = 1; j <= b.length; j++) {
      const substitute = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : sub);
      curr[j] = Math.min(substitute, prev[j]! + insDel, curr[j - 1]! + insDel);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

function pathSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return 1 - segmentDistance(a, b) / Math.max(a.length, b.length);
}

function queryDistance(a: Map<string, string>, b: Map<string, string>): number {
  let d = 0;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || other !== value) d++;
  }
  for (const key of b.keys()) if (!a.has(key)) d++;
  return d;
}

function querySimilarity(a: Map<string, string>, b: Map<string, string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  return 1 - queryDistance(a, b) / Math.max(a.size, b.size);
}

/** Pairwise similarity in [0, 1]: hard 0 when hosts differ, else the weighted path+query blend. */
export function pairScore(a: NormalizedUrl, b: NormalizedUrl): number {
  if (a.host !== b.host) return 0;
  return DEDUPE.weightPath * pathSimilarity(a.segments, b.segments) + DEDUPE.weightQuery * querySimilarity(a.params, b.params);
}

export type DedupeRole = 'baseline' | 'closed' | 'ignored';

export interface DedupeEntry {
  tabId: number;
  role: DedupeRole;
  /** Similarity to the baseline it was compared against; present for closed tabs. */
  score?: number;
  /** Tab id of the baseline; present for closed tabs. */
  baselineId?: number;
}

export interface DedupePlan {
  /** Every eligible tab, in comparison (recency) order. */
  entries: DedupeEntry[];
  closedIds: number[];
}

/**
 * Baseline-scan pass over eligible tabs, O(n^2) worst case: sort by lastAccessed descending
 * (id ascending as tie-break); each surviving tab becomes a baseline and is compared against
 * EVERY unmarked, parseable tab below it — any match at score >= threshold is marked closed
 * and skipped afterwards; the next unmarked tab becomes the next baseline. This collapses each
 * duplicate family to its newest member no matter how many unrelated tabs sit between them.
 * Unparseable URLs are ignored: never closed, never a baseline. Pure — unit tested.
 */
export function planDedupe(eligible: Browser.tabs.Tab[], threshold: number): DedupePlan {
  const sorted = [...eligible].sort(
    (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || (a.id ?? 0) - (b.id ?? 0),
  );
  // Normalize once per tab; null marks an unparseable URL.
  const norms = sorted.map((tab) =>
    typeof tab.url === 'string' && tab.url.length > 0 ? normalizeUrl(tab.url) : null,
  );
  const entries: DedupeEntry[] = [];
  const closedIds: number[] = [];
  const closed = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const tabId = sorted[i]!.id as number;
    const norm = norms[i];
    if (closed.has(tabId)) continue;
    if (!norm) {
      entries.push({ tabId, role: 'ignored' });
      continue;
    }
    entries.push({ tabId, role: 'baseline' });
    for (let j = i + 1; j < sorted.length; j++) {
      const otherId = sorted[j]!.id as number;
      const otherNorm = norms[j];
      if (closed.has(otherId) || !otherNorm) continue;
      const score = pairScore(norm, otherNorm);
      if (score >= threshold) {
        entries.push({ tabId: otherId, role: 'closed', score: Math.round(score * 1000) / 1000, baselineId: tabId });
        closedIds.push(otherId);
        closed.add(otherId);
      }
    }
  }
  return { entries, closedIds };
}
