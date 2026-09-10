import { browser } from 'wxt/browser';
import type { Browser } from 'wxt/browser';
import type { ApplyReport, EffectiveBackend, GroupPlan } from './types';
import { applyStackPlans, type StackApi } from './vivaldi-stacks';

function isUngrouped(tab: Browser.tabs.Tab): boolean {
  return tab.groupId == null || tab.groupId <= 0;
}

/** The single place WXT's tab types meet Vivaldi's undocumented vivExtData surface. */
export function stackApi(): StackApi {
  return browser.tabs as unknown as StackApi;
}

export interface ApplyOptions {
  /** Vivaldi: native groupIds are invisible and possibly stale, so tabs carrying one may still be grouped. */
  treatGroupedAsUngrouped?: boolean;
}

export async function applyPlans(
  plans: GroupPlan[],
  windowId: number,
  backend: EffectiveBackend,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  if (backend === 'stacks') return applyStackPlans(plans, windowId, stackApi());
  return applyNativePlans(plans, windowId, options);
}

async function applyNativePlans(plans: GroupPlan[], windowId: number, options: ApplyOptions): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, skipped: 0, failed: 0, failures: [], backend: 'native' };
  if (plans.length === 0) return report;

  const tabs = await browser.tabs.query({ windowId });
  const live = new Map<number, Browser.tabs.Tab>();
  for (const tab of tabs) {
    if (tab.id != null) live.set(tab.id, tab);
  }

  for (const plan of plans) {
    try {
      // On Vivaldi a groupId is invisible, possibly stale state — never a reason to exclude a
      // tab; re-grouping it just moves it out of the old group.
      const tabIds = plan.tabIds.filter((id) => {
        const tab = live.get(id);
        return tab != null && (isUngrouped(tab) || options.treatGroupedAsUngrouped === true);
      });
      if (tabIds.length < 2) {
        report.skipped++;
        continue;
      }
      // WxtBrowser remaps chrome's overloaded tabs.group through Omit, collapsing overloads into intersections; casts restore the real signatures (tabIds is guaranteed non-empty by the check above).
      const groupId = (await browser.tabs.group({
        tabIds: tabIds as [number, ...number[]],
        createProperties: { windowId },
      })) as number;
      await browser.tabGroups.update(groupId, { title: plan.name });
      report.applied++;
    } catch (e) {
      report.failed++;
      report.failures.push(`Group "${plan.name}": ${(e as Error).message}`);
    }
  }
  return report;
}
