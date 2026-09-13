import { browser } from 'wxt/browser';
import { LOG } from './constants';
import { isDedupeRecord, isSelectionRecord } from './types';
import type { AnyLogRecord, LogIndex, LogIndexEntry, LogKind } from './types';

/** Any record kind the log can store. */
export type { AnyLogRecord } from './types';

/**
 * Developer-facing logs (three record kinds: `run`, `selection`, and `dedupe`).
 *
 * Layout: one lightweight index key plus one payload key per record
 * (`onekey-tab:run:<id>`, shared by all kinds — ids are unique). The
 * index keeps a small projection (including each record's byte size) so the
 * log list page never loads full payloads; a single record is read on demand
 * when its details are opened. Stored size is capped (`LOG.maxTotalBytes`,
 * safely inside Chrome's default 10MB `storage.local` quota), evicting oldest
 * records first regardless of kind. A failed write (e.g. Firefox's global
 * disk quota) retries once by dropping the oldest record.
 *
 * The log never contains the API key; callers must not put it into messages.
 */

let idCounter = 0;

export function newRunId(now = Date.now()): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${now.toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyIndex(): LogIndex {
  return { entries: [], totalBytes: 0 };
}

/** Estimated serialized size of a full record — used for the byte cap. */
export function recordBytes(record: AnyLogRecord): number {
  return JSON.stringify(record).length;
}

function entryFromRecord(record: AnyLogRecord): LogIndexEntry {
  if (isSelectionRecord(record)) {
    return {
      id: record.id,
      kind: 'selection',
      ts: record.ts,
      outcome: 'success',
      durationMs: 0,
      tabCount: record.totalTabs,
      excludedCount: record.excludedCount,
      bytes: recordBytes(record),
    };
  }
  if (isDedupeRecord(record)) {
    return {
      id: record.id,
      kind: 'dedupe',
      ts: record.ts,
      outcome: 'success',
      durationMs: 0,
      tabCount: record.tabs.length,
      closedCount: record.closedCount ?? record.plannedCloseCount,
      bytes: recordBytes(record),
    };
  }
  const lastCall = record.calls?.[record.calls.length - 1];
  return {
    id: record.id,
    kind: 'run',
    ts: record.ts,
    outcome: record.outcome,
    durationMs: record.durationMs,
    tabCount: record.tabCount,
    model: lastCall?.model,
    error: record.error,
    bytes: recordBytes(record),
  };
}

/**
 * Append a record to an index, keeping `totalBytes` exact (sum of each entry's
 * stored `bytes`) and applying the byte cap by dropping the oldest runs first.
 * Pure — unit tested.
 */
export function appendToIndex(index: LogIndex, record: AnyLogRecord, capBytes: number): LogIndex {
  const entry = entryFromRecord(record);
  const entries = [...index.entries, entry];
  let totalBytes = index.totalBytes + entry.bytes;
  let drop = 0;
  // Drop oldest (front) while over cap, but never below a single record.
  while (totalBytes > capBytes && entries.length - drop > 1) {
    totalBytes -= entries[drop]!.bytes;
    drop++;
  }
  if (drop > 0) entries.splice(0, drop);
  return { entries, totalBytes };
}

/** Remove an entry from the index, keeping `totalBytes` exact. Pure. */
export function removeFromIndex(index: LogIndex, id: string): LogIndex {
  const entries = index.entries.filter((e) => e.id !== id);
  const removed = index.entries.find((e) => e.id === id);
  return { entries, totalBytes: index.totalBytes - (removed?.bytes ?? 0) };
}

// ---- Async storage IO (thin wrappers over the pure helpers) ----

async function loadIndex(): Promise<LogIndex> {
  const res = await browser.storage.local.get(LOG.indexKey);
  const raw = (res[LOG.indexKey] as LogIndex | undefined) ?? null;
  if (raw && Array.isArray(raw.entries)) {
    // Indexes written before the selection log existed have no `kind`; they are runs.
    return { entries: raw.entries.map((e) => ({ ...e, kind: (e.kind ?? 'run') as LogKind })), totalBytes: raw.totalBytes };
  }
  return emptyIndex();
}

async function saveIndex(index: LogIndex): Promise<void> {
  await browser.storage.local.set({ [LOG.indexKey]: index });
}

/** Per-record payload key prefix; shared by all record kinds (ids are unique). */
function runKey(id: string): string {
  return LOG.runKeyPrefix + id;
}

function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /quota|exceeded|space/i.test(msg);
}

/** Persist one full record, pruning by byte cap, retrying once on quota errors. */
export async function recordLog(record: AnyLogRecord): Promise<void> {
  const payloadKey = runKey(record.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    const index = await loadIndex();
    const next = appendToIndex(index, record, LOG.maxTotalBytes);
    try {
      await browser.storage.local.set({ [payloadKey]: record, [LOG.indexKey]: next });
      return;
    } catch (e) {
      // Retry once by dropping the oldest record to free space.
      if (isQuotaError(e) && attempt === 0 && next.entries.length > 1) {
        const [oldest] = next.entries;
        await removeIndexEntryOnly(oldest!.id);
        continue;
      }
      throw e;
    }
  }
}

/** Drop an index entry + payload for a single record. */
async function removeIndexEntryOnly(id: string): Promise<void> {
  await browser.storage.local.remove(runKey(id));
  const index = await loadIndex();
  await saveIndex(removeFromIndex(index, id));
}

/** Overwrite an existing record (e.g. backfilling dedupe outcomes); appends it when unknown. */
export async function updateLogRecord(record: AnyLogRecord): Promise<void> {
  const index = await loadIndex();
  if (!index.entries.some((e) => e.id === record.id)) {
    await recordLog(record);
    return;
  }
  const next = appendToIndex(removeFromIndex(index, record.id), record, LOG.maxTotalBytes);
  await browser.storage.local.set({ [runKey(record.id)]: record, [LOG.indexKey]: next });
}

/** Drop a single record by id (payload + index entry). */
export async function removeRecord(id: string): Promise<void> {
  await removeIndexEntryOnly(id);
}

/** Remove all log records and the index. Returns how many were removed. */
export async function clearLog(): Promise<number> {
  const index = await loadIndex();
  const keys = index.entries.map((e) => runKey(e.id));
  if (keys.length > 0) await browser.storage.local.remove(keys);
  await browser.storage.local.remove(LOG.indexKey);
  return index.entries.length;
}

/** Most recent `window` records, newest first, reading only the index. Sorted by ts so a backfilled record (re-appended by updateLogRecord) stays in chronological display order. */
export async function listRecent(window: number = LOG.listWindow): Promise<LogIndexEntry[]> {
  const index = await loadIndex();
  return [...index.entries].sort((a, b) => b.ts - a.ts).slice(0, window);
}

/** Total count of recorded records (for the "clear all (N records)" labeling). */
export async function countRecords(): Promise<number> {
  const index = await loadIndex();
  return index.entries.length;
}

/** Fetch a single full record by id; null if gone. */
export async function getRecord(id: string): Promise<AnyLogRecord | null> {
  const res = await browser.storage.local.get(runKey(id));
  return (res[runKey(id)] as AnyLogRecord | undefined) ?? null;
}
