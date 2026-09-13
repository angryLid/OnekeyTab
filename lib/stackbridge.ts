// Wxt-free by design: the runtime and tab API objects are injected at the composition point
// (entrypoints/background.ts), so this module — and the whole protocol — tests without a browser.
import { BRIDGE } from './constants';
import { isUngroupedGroupId } from './types';
import type { GroupingPort } from './grouping-port';
import type { ApplyReport, GroupInfo, GroupPlan, PortCaps, PortProbeResult } from './types';

/**
 * Client for the StackBridge mod protocol (envelope v2) — see the frozen upstream docs:
 * github.com/angryLid/Awesome-Vivaldi Bridge/README.md + Bridge/API.md. This file is the sole
 * consumer of that protocol; nothing else in the codebase may grow a second one.
 *
 * Writes go through the v2 declarative layout.apply: the mod computes the diff and
 * orchestrates everything in one locked, idempotent pass, so worker restarts and retries
 * can never tear a grouping run into a wrong intermediate state.
 */

export const DEFAULT_UI_EXTENSION_ID = BRIDGE.defaultUiExtensionId;

/** The slice of browser.runtime the client needs; structural so tests inject fakes. */
export interface BridgeApi {
  /** Rejects on chrome.runtime.lastError (immediately when no receiver exists); resolves undefined when the receiver sent no response. */
  sendMessage(extId: string, message: unknown): Promise<unknown>;
}

/** Structural view of the injected runtime object (background passes browser.runtime with a cast). */
export interface BridgeRuntime {
  sendMessage(extensionId: string, message: unknown): Promise<unknown>;
}

export function bridgeApi(runtime: BridgeRuntime): BridgeApi {
  return {
    sendMessage(extId, message) {
      return runtime.sendMessage(extId, message);
    },
  };
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

class BridgeTimeoutError extends Error {
  constructor() {
    super('bridge request timed out');
    this.name = 'BridgeTimeoutError';
  }
}

interface BridgeRequest {
  v: number;
  id: string;
  type: 'request';
  action: string;
  params?: Record<string, unknown>;
}

interface BridgeResponse {
  v?: number;
  id?: string;
  type?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export interface BridgeCapabilities {
  protocol?: number;
  actions?: string[];
}

async function callBridge<T>(
  api: BridgeApi,
  extId: string,
  action: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<T> {
  const id = crypto.randomUUID();
  const request: BridgeRequest = { v: BRIDGE.protocolVersion, id, type: 'request', action, params };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = (await Promise.race([
      api.sendMessage(extId, request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BridgeTimeoutError()), timeoutMs);
      }),
    ])) as BridgeResponse;
    if (response?.v !== BRIDGE.protocolVersion || response.id !== id || response.type !== 'response') {
      throw new BridgeError('BAD_RESPONSE', 'malformed or mismatched bridge response');
    }
    if (!response.ok) {
      throw new BridgeError(response.error?.code ?? 'INTERNAL', response.error?.message ?? 'bridge error');
    }
    return response.result as T;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

// ---- Probe (memoized per service-worker lifetime) ----

let probeMemo: PortProbeResult | null = null;

/** Test hook: memoization must not leak between test cases. */
export function resetBridgeProbeCache(): void {
  probeMemo = null;
}

export async function probeBridge(api: BridgeApi, extId: string): Promise<PortProbeResult> {
  if (probeMemo) return probeMemo;
  probeMemo = await runProbe(api, extId);
  return probeMemo;
}

async function runProbe(api: BridgeApi, extId: string): Promise<PortProbeResult> {
  try {
    await callBridge<unknown>(api, extId, 'bridge.ping', undefined, BRIDGE.pingTimeoutMs);
  } catch (e) {
    return classifyTransportError(e);
  }
  try {
    const caps = await callBridge<BridgeCapabilities>(api, extId, 'bridge.capabilities', undefined, BRIDGE.requestTimeoutMs);
    if (caps.protocol !== BRIDGE.protocolVersion) {
      return { ok: false, reason: 'unsupported', detail: `bridge speaks protocol ${String(caps.protocol)}` };
    }
    const missing = ['stacks.list', 'layout.apply'].filter((action) => !(caps.actions ?? []).includes(action));
    if (missing.length > 0) {
      return { ok: false, reason: 'unsupported', detail: `bridge lacks actions: ${missing.join(', ')}` };
    }
    return { ok: true };
  } catch (e) {
    return classifyTransportError(e);
  }
}

function classifyTransportError(e: unknown): PortProbeResult {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof BridgeTimeoutError) return { ok: false, reason: 'timeout', detail: message };
  // An absent listener and a manifest-level delivery block produce the same immediate error; both mean "unusable".
  if (/receiving end does not exist|establish connection/i.test(message)) {
    return { ok: false, reason: 'no-listener', detail: message };
  }
  if (e instanceof BridgeError && e.code === 'NOT_PAIRED') return { ok: false, reason: 'not-paired', detail: message };
  return { ok: false, reason: 'error', detail: message };
}

// ---- Stack reads and writes ----

interface BridgeStack {
  id?: unknown;
  name?: unknown;
  tabIds?: unknown;
}

/** stacks.list → GroupInfo; junk entries are dropped rather than trusted. */
export async function listStacks(api: BridgeApi, extId: string, windowId?: number): Promise<GroupInfo[]> {
  const stacks = await callBridge<BridgeStack[]>(
    api,
    extId,
    'stacks.list',
    windowId != null ? { windowId } : undefined,
    BRIDGE.requestTimeoutMs,
  );
  if (!Array.isArray(stacks)) return [];
  const groups: GroupInfo[] = [];
  for (const stack of stacks) {
    const id = typeof stack?.id === 'string' && stack.id.length > 0 ? stack.id : null;
    const tabIds = Array.isArray(stack?.tabIds)
      ? stack.tabIds.filter((tabId): tabId is number => typeof tabId === 'number')
      : [];
    if (id == null || tabIds.length === 0) continue;
    groups.push({ id, name: typeof stack.name === 'string' ? stack.name : '', tabIds });
  }
  return groups;
}

/** layout.apply result slice the port consumes. */
interface BridgeLayoutResult {
  rev?: unknown;
  applied?: unknown;
  dissolved?: unknown;
  skipped?: unknown;
}

/**
 * layout.apply: the whole desired layout in one declarative call. Idempotent — groups already
 * in the requested state come back flagged unchanged and cost nothing; re-sending after a
 * partial failure converges. `ungrouped` tabs are forced out of any stack.
 */
export async function applyLayout(
  api: BridgeApi,
  extId: string,
  groups: Array<{ name: string; tabIds: number[] }>,
  ungrouped?: number[],
): Promise<BridgeLayoutResult> {
  return callBridge<BridgeLayoutResult>(
    api,
    extId,
    'layout.apply',
    {
      groups: groups.map((g) => ({ name: g.name.slice(0, BRIDGE.nameMax), tabIds: g.tabIds })),
      ...(ungrouped && ungrouped.length > 0 ? { ungrouped } : {}),
    },
    BRIDGE.layoutTimeoutMs,
  );
}

/** stacks.create (v1 action, still served); kept for rollback and manual probing. */
export async function createStack(api: BridgeApi, extId: string, tabIds: number[], name: string): Promise<string> {
  const result = await callBridge<{ groupExtId?: string }>(
    api,
    extId,
    'stacks.create',
    { tabIds, name: name.slice(0, BRIDGE.nameMax) },
    BRIDGE.requestTimeoutMs,
  );
  return typeof result?.groupExtId === 'string' ? result.groupExtId : '';
}

export function describeBridgeError(e: unknown): string {
  if (e instanceof BridgeError) return `${e.code}: ${e.message}`;
  return (e as Error).message;
}

// ---- The vivaldi-bridge port ----

/** The slice of browser.tabs the bridge port uses for liveness and the mixed-state guard. */
export interface BridgeTabsApi {
  query(info: { windowId?: number }): Promise<Array<{ id?: number; groupId?: number }>>;
  ungroup(tabIds: number[]): Promise<unknown>;
}

export function createBridgePort(api: BridgeApi, uiExtensionId: string, tabs: BridgeTabsApi): GroupingPort {
  const caps: PortCaps = {
    visibleGroups: true,
    nativeGroupsTrustworthy: false,
    userGroupsReadable: true,
    visibleGroupReason: 'stacked',
  };
  return {
    id: 'vivaldi-bridge',
    caps,
    probe() {
      return probeBridge(api, uiExtensionId);
    },
    async listGroups(windowId) {
      try {
        return await listStacks(api, uiExtensionId, windowId);
      } catch (e) {
        // A failed read must never crash the run: an empty answer excludes nothing, the same as a window with no stacks.
        console.warn('[onekey-tab] stacks.list failed; treating window as unstacked:', (e as Error).message);
        return [];
      }
    },
    async apply(plans, windowId): Promise<ApplyReport> {
      const report: ApplyReport = { applied: 0, skipped: 0, failed: 0, failures: [], backend: 'stacks' };
      if (plans.length === 0) return report;

      const tabsInWindow = await tabs.query({ windowId });
      const live = new Set<number>();
      const nativeGrouped: number[] = [];
      for (const tab of tabsInWindow) {
        if (tab.id == null) continue;
        live.add(tab.id);
        if (!isUngroupedGroupId(tab.groupId)) nativeGrouped.push(tab.id);
      }
      // Clear leftover invisible Chromium groups first: a visible stack on top of an invisible
      // group is an untested mixed state (H14 covers what the bridge itself would do here).
      if (nativeGrouped.length > 0) {
        try {
          await tabs.ungroup(nativeGrouped);
        } catch (e) {
          report.failures.push(`Native ungroup failed: ${(e as Error).message}`);
        }
      }

      // One declarative call for the whole run: the mod diffs, orchestrates, and reports
      // per-group outcomes. Groups whose live membership drops below two tabs are skipped
      // client-side; unmentioned tabs and stacks stay untouched (same as the old v1 loop).
      const groups: Array<{ name: string; tabIds: number[] }> = [];
      for (const plan of plans) {
        const tabIds = plan.tabIds.filter((tabId) => live.has(tabId));
        if (tabIds.length < 2) {
          report.skipped++;
          continue;
        }
        groups.push({ name: plan.name, tabIds });
      }
      if (groups.length === 0) return report;
      try {
        const result = await applyLayout(api, uiExtensionId, groups);
        const appliedList = Array.isArray(result.applied) ? (result.applied as Array<{ unchanged?: boolean }>) : [];
        report.applied = appliedList.length;
        report.skipped += Array.isArray(result.skipped) ? result.skipped.length : 0;
      } catch (e) {
        // Transactional failure: nothing is rescued mid-run; the next run re-probes and the
        // declarative re-send converges (docs/grouping-port.md).
        report.failed = groups.length;
        report.failures.push(`layout.apply failed: ${describeBridgeError(e)}`);
      }
      return report;
    },
  };
}
