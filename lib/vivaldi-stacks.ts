import type { ApplyReport, GroupPlan, StackProbeResult } from './types';

/** A tab as the stack writer sees it: the fields WXT's Tab type does not model are `vivExtData`. */
export interface StackTab {
  id?: number;
  groupId?: number;
  vivExtData?: unknown;
}

/**
 * The slice of browser.tabs the stack writer needs, with Vivaldi's vivExtData surface included.
 * Structural on purpose: tests pass fakes without importing wxt/browser, and the single
 * `browser.tabs as unknown as StackApi` cast lives in lib/apply-groups.ts.
 */
export interface StackApi {
  query(info: { windowId?: number }): Promise<StackTab[]>;
  get(tabId: number): Promise<StackTab>;
  create(props: { url?: string; active?: boolean }): Promise<{ id?: number }>;
  update(tabId: number, props: { vivExtData: string }): Promise<unknown>;
  remove(tabId: number): Promise<unknown>;
  ungroup(tabIds: number[]): Promise<unknown>;
}

/** vivExtData keys that define stack membership; unstacking deletes exactly these. */
export const STACK_FIELDS: readonly string[] = ['group', 'groupColor', 'fixedGroupTitle'];

/**
 * Safe parse of a vivExtData value. Real Vivaldi injects a JSON string; objects are accepted
 * defensively (older builds / partial typings), anything else — malformed JSON, null, arrays,
 * numbers, empty strings — is null.
 */
export function parseVivExtData(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') {
    return raw != null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  }
  if (raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read-modify-write core: assign and/or delete keys while preserving everything unknown that
 * Vivaldi keeps in vivExtData (workspaceId, fixedTitle, tiling layout, follower ids, ext_id...).
 * Pure; throws on unparseable input so callers never stringify away Vivaldi state.
 */
export function applyVivExtDataKeys(
  raw: string,
  update: { assign?: Record<string, unknown>; deleteKeys?: readonly string[] },
): string {
  const parsed = parseVivExtData(raw);
  if (parsed == null) throw new Error(`vivExtData is not a JSON object: ${JSON.stringify(raw).slice(0, 80)}`);
  if (update.deleteKeys) {
    for (const key of update.deleteKeys) Reflect.deleteProperty(parsed, key);
  }
  if (update.assign) Object.assign(parsed, update.assign);
  return JSON.stringify(parsed);
}

/** The stack test: a parsed vivExtData carrying a non-empty string `group`. */
export function stackIdOf(tab: { vivExtData?: unknown }): string | null {
  const group = parseVivExtData(tab.vivExtData)?.group;
  return typeof group === 'string' && group.length > 0 ? group : null;
}

let probeCache: StackProbeResult | null = null;

/** Test hook: the memoization must not leak between test cases. */
export function resetProbeCache(): void {
  probeCache = null;
}

/**
 * One probe per service-worker lifetime (memoized unless forced): create a disposable
 * about:blank tab, write stack keys into its vivExtData, read back, roll back, remove.
 * The active write-then-read-back round-trip is the sole arbiter — vivExtData being present
 * says nothing about whether writes persist, and a fresh blank tab may not even carry the
 * field at creation time (host experiment H7: exactly this case failed the first probe design).
 */
export async function probeStackSupport(api: StackApi, force = false): Promise<StackProbeResult> {
  if (!force && probeCache) return probeCache;
  probeCache = await runProbe(api);
  return probeCache;
}

/** String form for read-modify-write; object-form vivExtData (older builds) is preserved as JSON, never discarded. */
function rawOf(tab: StackTab): string {
  if (typeof tab.vivExtData === 'string') return tab.vivExtData;
  return JSON.stringify(parseVivExtData(tab.vivExtData) ?? {});
}

/** Some builds attach vivExtData to a fresh tab late (or never, on blank pages); short retries absorb the lag. */
const PROBE_READ_RETRY_MS = 150;
const PROBE_READ_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProbe(api: StackApi): Promise<StackProbeResult> {
  let probeTabId: number | null = null;
  try {
    const created = await api.create({ url: 'about:blank', active: false });
    probeTabId = created.id ?? null;
    if (probeTabId == null) return { supported: false, reason: 'error', detail: 'probe tab has no id' };
    let tab = await api.get(probeTabId);
    for (let attempt = 0; attempt < PROBE_READ_RETRIES && tab.vivExtData == null; attempt++) {
      await sleep(PROBE_READ_RETRY_MS);
      tab = await api.get(probeTabId);
    }
    const testGroup = `probe-${crypto.randomUUID()}`;
    await api.update(probeTabId, { vivExtData: applyVivExtDataKeys(rawOf(tab), { assign: { group: testGroup } }) });
    const reread = await api.get(probeTabId);
    if (stackIdOf(reread) !== testGroup) return { supported: false, reason: 'write-rejected' };
    return { supported: true };
  } catch (e) {
    return { supported: false, reason: 'error', detail: (e as Error).message };
  } finally {
    // Roll back the probe keys and remove the tab on every path; both are best-effort.
    if (probeTabId != null) {
      try {
        const tab = await api.get(probeTabId);
        if (parseVivExtData(tab.vivExtData)?.group != null) {
          await api.update(probeTabId, {
            vivExtData: applyVivExtDataKeys(String(tab.vivExtData), { deleteKeys: STACK_FIELDS }),
          });
        }
      } catch {
        // rollback is best-effort
      }
      try {
        await api.remove(probeTabId);
      } catch {
        // the probe tab may already be gone
      }
    }
  }
}

/**
 * Apply plans as Vivaldi Tab Stacks: clear leftover invisible native groups, then per plan
 * write a shared `group` UUID plus `fixedGroupTitle` into every member's vivExtData, then
 * verify by reading back. Failures are per tab / per plan — other plans still apply.
 */
export async function applyStackPlans(plans: GroupPlan[], windowId: number, api: StackApi): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, skipped: 0, failed: 0, failures: [], backend: 'stacks' };
  if (plans.length === 0) return report;

  const tabs = await api.query({ windowId });
  const live = new Map<number, StackTab>();
  for (const tab of tabs) {
    if (tab.id != null) live.set(tab.id, tab);
  }

  // A visible stack on top of an invisible native group is an untested state; clear native
  // leftovers first so the stack write is the only grouping on each tab.
  const nativeGrouped = [...live.values()].filter((t) => (t.groupId ?? -1) > 0).map((t) => t.id as number);
  if (nativeGrouped.length > 0) {
    try {
      await api.ungroup(nativeGrouped);
    } catch (e) {
      report.failures.push(`Native ungroup failed: ${(e as Error).message}`);
    }
  }

  const written: Array<{ name: string; group: string; tabIds: number[] }> = [];
  for (const plan of plans) {
    const tabIds = plan.tabIds.filter((id) => live.has(id));
    if (tabIds.length < 2) {
      report.skipped++;
      continue;
    }
    const group = crypto.randomUUID();
    const failedTabs: string[] = [];
    await Promise.all(
      tabIds.map(async (tabId) => {
        try {
          const tab = live.get(tabId) as StackTab;
          const vivExtData = applyVivExtDataKeys(rawOf(tab), { assign: { group, fixedGroupTitle: plan.name } });
          await api.update(tabId, { vivExtData });
        } catch (e) {
          failedTabs.push(`tab ${tabId}: ${(e as Error).message}`);
        }
      }),
    );
    if (failedTabs.length > 0) {
      report.failed++;
      for (const message of failedTabs) report.failures.push(`Stack "${plan.name}": ${message}`);
      continue;
    }
    written.push({ name: plan.name, group, tabIds });
  }

  // Read-back verification: "update resolved" and "write persisted" are different facts, and
  // the point of this backend is a visible result — a dropped write must show up in the log.
  let current: Map<number, StackTab> | null = null;
  try {
    current = new Map((await api.query({ windowId })).filter((t) => t.id != null).map((t) => [t.id as number, t]));
  } catch {
    report.failures.push('Stack verification query failed; writes unverified.');
  }
  for (const entry of written) {
    let verified = true;
    for (const tabId of entry.tabIds) {
      if (current != null && !current.has(tabId)) continue; // closed mid-run, not a write failure
      try {
        const tab = await api.get(tabId);
        if (stackIdOf(tab) !== entry.group) {
          verified = false;
          report.failures.push(`Stack "${entry.name}": tab ${tabId}: group not persisted`);
        }
      } catch {
        // tab gone mid-run; truth comes from the re-query, not the API result
      }
    }
    if (verified) report.applied++;
    else report.failed++;
  }
  return report;
}

/** Remove the stack keys from the given tabs; unused by the pipeline, exported for tests and a future unstack UI. */
export async function unstackTabs(tabIds: number[], api: StackApi): Promise<void> {
  await Promise.all(
    tabIds.map(async (tabId) => {
      const tab = await api.get(tabId);
      if (parseVivExtData(tab.vivExtData) == null) return;
      await api.update(tabId, { vivExtData: applyVivExtDataKeys(String(tab.vivExtData), { deleteKeys: STACK_FIELDS }) });
    }),
  );
}
