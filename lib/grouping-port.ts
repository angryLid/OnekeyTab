// This module is deliberately wxt-free: the browser API objects are injected at the composition
// point (entrypoints/background.ts), so tests run without any browser environment.
import { BRIDGE } from './constants';
import { isUngroupedGroupId } from './types';
import type {
  ApplyReport,
  EffectiveBackend,
  GroupInfo,
  GroupPlan,
  PortCaps,
  PortId,
  PortProbeRecord,
  PortProbeResult,
} from './types';

/**
 * The vendor adaptation boundary: everything above it (selection, dedupe, model, logging) is
 * browser-agnostic; everything below it speaks to a concrete grouping mechanism. See
 * docs/grouping-port.md for the design and the accepted trade-offs.
 */
export interface GroupingPort {
  readonly id: PortId;
  readonly caps: PortCaps;
  /** Self-qualification; only called where availability is uncertain (the Vivaldi bridge). */
  probe(): Promise<PortProbeResult>;
  /** Authoritative visible-group membership; the single input to stacked/grouped exclusion. */
  listGroups(windowId: number): Promise<GroupInfo[]>;
  /** Whole-run commitment: every plan goes through this port; transports never mix mid-run. */
  apply(plans: GroupPlan[], windowId: number): Promise<ApplyReport>;
}

/** Inputs to the composition root: which browser the pipeline decided it is running in. */
export interface PortEnv {
  /** True when lib/vivaldi.ts detection fired for this browser. */
  isVivaldi: boolean;
}

/** Ready to run through one port, or blocked (Vivaldi without a working bridge). */
export type PortDecision =
  | { kind: 'ready'; port: GroupingPort; backend: EffectiveBackend; probe?: PortProbeRecord }
  | { kind: 'blocked'; reason: string; probe?: PortProbeRecord };

export interface PortPair {
  native: GroupingPort;
  bridge: GroupingPort;
}

// ---- Native port (Chromium / Firefox tab groups) ----

/** The slice of browser.tabs / browser.tabGroups the native port needs; structural for tests. */
export interface NativeTabLike {
  id?: number;
  groupId?: number;
}

export interface NativeTabsApi {
  query(info: { windowId?: number }): Promise<NativeTabLike[]>;
  group(options: { tabIds: [number, ...number[]]; createProperties?: { windowId?: number } }): Promise<number>;
}

export interface NativeTabGroupsApi {
  update(groupId: number, properties: { title?: string }): Promise<unknown>;
}

/** Factory requires the API objects: background passes browser.tabs / browser.tabGroups with a cast. */
export function nativePort(tabs: NativeTabsApi, tabGroups: NativeTabGroupsApi): GroupingPort {
  return {
    id: 'native',
    caps: {
      visibleGroups: true,
      nativeGroupsTrustworthy: true,
      userGroupsReadable: true,
      visibleGroupReason: 'grouped',
    },
    async probe() {
      // Platform APIs need no probe; the Firefox min-version floor for tabGroups is a manifest concern.
      return { ok: true };
    },
    async listGroups(windowId) {
      const tabsInWindow = await tabs.query({ windowId });
      const byGroup = new Map<number, number[]>();
      for (const tab of tabsInWindow) {
        const { id, groupId } = tab;
        if (id == null || groupId == null || groupId <= 0) continue;
        const list = byGroup.get(groupId) ?? [];
        list.push(id);
        byGroup.set(groupId, list);
      }
      return [...byGroup].map(([groupId, tabIds]) => ({ id: String(groupId), name: '', tabIds }));
    },
    async apply(plans, windowId) {
      const report: ApplyReport = { applied: 0, skipped: 0, failed: 0, failures: [], backend: 'native' };
      if (plans.length === 0) return report;

      const tabsInWindow = await tabs.query({ windowId });
      const live = new Map<number, NativeTabLike>();
      for (const tab of tabsInWindow) {
        if (tab.id != null) live.set(tab.id, tab);
      }

      for (const plan of plans) {
        try {
          // Candidates are ungrouped by selection; the liveness re-check is the last word.
          const tabIds = plan.tabIds.filter((id) => {
            const tab = live.get(id);
            return tab != null && isUngroupedGroupId(tab.groupId);
          });
          if (tabIds.length < 2) {
            report.skipped++;
            continue;
          }
          const groupId = await tabs.group({
            tabIds: tabIds as [number, ...number[]],
            createProperties: { windowId },
          });
          await tabGroups.update(groupId, { title: plan.name });
          report.applied++;
        } catch (e) {
          report.failed++;
          report.failures.push(`Group "${plan.name}": ${(e as Error).message}`);
        }
      }
      return report;
    },
  };
}

// ---- Composition root ----

/**
 * The only place transport policy lives, and it is browser-driven, not configurable: on Vivaldi
 * the bridge is the sole runnable port (a failed probe blocks the run exactly like a missing
 * API key — recorded, options page opened by the caller); everywhere else the native port runs.
 */
export async function selectPort(env: PortEnv, ports: PortPair): Promise<PortDecision> {
  if (!env.isVivaldi) {
    return { kind: 'ready', port: ports.native, backend: 'native' };
  }

  const probe = await ports.bridge.probe();
  const record: PortProbeRecord = { ...probe, ts: Date.now() };
  if (!probe.ok) {
    return { kind: 'blocked', reason: blockReason(probe), probe: record };
  }
  return { kind: 'ready', port: ports.bridge, backend: 'stacks', probe: record };
}

/**
 * One human sentence for a failed probe — the single source shared by the run-block error
 * (selectPort) and the options status line. Callers add their own framing (install link, next step).
 */
export function describeProbeReason(probe: PortProbeResult): string {
  if (probe.reason === 'no-listener') return 'StackBridge mod not detected (or blocked by Vivaldi)';
  if (probe.reason === 'timeout') return `StackBridge mod did not respond${probe.detail ? `: ${probe.detail}` : ''}`;
  if (probe.reason === 'not-paired') return 'StackBridge mod rejected this extension (NOT_PAIRED); pair it in the window.html console: StackBridge.pair(<this extension id>)';
  return `StackBridge mod unusable (${probe.reason ?? 'unknown'}${probe.detail ? `: ${probe.detail}` : ''})`;
}

function blockReason(probe: PortProbeResult): string {
  if (probe.reason === 'no-listener') {
    return `${describeProbeReason(probe)}. Grouping on Vivaldi requires it — install guide: ${BRIDGE.installDocsUrl}`;
  }
  return `${describeProbeReason(probe)}.`;
}
