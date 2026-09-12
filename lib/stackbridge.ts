// Wxt-free by design: the runtime and tab API objects are injected at the composition point
// (entrypoints/background.ts), so this module — and the whole protocol — tests without a browser.
import { BRIDGE } from './constants';
import type { GroupingPort } from './grouping-port';
import type { ApplyReport, GroupInfo, GroupPlan, PortCaps, PortProbeResult } from './types';

/**
 * Client for the StackBridge mod protocol (envelope v1) — see the frozen upstream docs:
 * github.com/angryLid/Awesome-Vivaldi Bridge/README.md + Bridge/API.md. This file is the sole
 * consumer of that protocol; nothing else in the codebase may grow a second one.
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

// ---- Probe (memoized per service-worker lifetime; forced when the stacks setting is explicit) ----

let probeMemo: PortProbeResult | null = null;

/** Test hook: memoization must not leak between test cases. */
export function resetBridgeProbeCache(): void {
  probeMemo = null;
}

export async function probeBridge(api: BridgeApi, extId: string, force = false): Promise<PortProbeResult> {
  if (!force && probeMemo) return probeMemo;
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
    const missing = ['stacks.list', 'stacks.create'].filter((action) => !(caps.actions ?? []).includes(action));
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

/** stacks.create; the 50-char cap is enforced here so log names always match stack names. */
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

export function createBridgePort(
  api: BridgeApi,
  uiExtensionId: string,
  forceProbe: () => boolean,
  tabs: BridgeTabsApi,
): GroupingPort {
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
      return probeBridge(api, uiExtensionId, forceProbe());
    },
    async listGroups(windowId) {
      try {
        return await listStacks(api, uiExtensionId, windowId);
      } catch (e) {
        // A failed read must never crash the run: an empty answer excludes nothing, the same as a window with no stacks.
        console.warn('[ai-tab-grouper] stacks.list failed; treating window as unstacked:', (e as Error).message);
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
        if ((tab.groupId ?? -1) > 0) nativeGrouped.push(tab.id);
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

      for (const plan of plans) {
        const tabIds = plan.tabIds.filter((tabId) => live.has(tabId));
        if (tabIds.length < 2) {
          report.skipped++;
          continue;
        }
        try {
          await createStack(api, uiExtensionId, tabIds, plan.name);
          report.applied++;
        } catch (e) {
          // No mid-run rescue: the plan fails with a log entry, the next run re-probes (docs/grouping-port.md).
          report.failed++;
          report.failures.push(`Stack "${plan.name}": ${describeBridgeError(e)}`);
        }
      }
      return report;
    },
  };
}
