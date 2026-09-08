import { browser } from 'wxt/browser';
import type { Browser } from 'wxt/browser';
import type { ApplyReport, GroupPlan } from './types';

function isUngrouped(tab: Browser.tabs.Tab): boolean {
  return tab.groupId == null || tab.groupId <= 0;
}

export async function applyPlans(plans: GroupPlan[], windowId: number): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, skipped: 0, failed: 0, failures: [] };
  if (plans.length === 0) return report;

  const tabs = await browser.tabs.query({ windowId });
  const live = new Map<number, Browser.tabs.Tab>();
  for (const tab of tabs) {
    if (tab.id != null) live.set(tab.id, tab);
  }

  for (const plan of plans) {
    try {
      const tabIds = plan.tabIds.filter((id) => {
        const tab = live.get(id);
        return tab != null && isUngrouped(tab);
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
