import { clearBadge, setClosedFlash, setError, setPending, setSkip, reconcileOnStartup } from '@/lib/badge';
import { clearLastError, getConfig, setLastError } from '@/lib/config';
import { DEDUPE, LIMITS, LOG_PREFIX } from '@/lib/constants';
import { planDedupe } from '@/lib/dedupe';
import { nativePort, selectPort } from '@/lib/grouping-port';
import type { NativeTabGroupsApi, NativeTabsApi } from '@/lib/grouping-port';
import { chatCompletion } from '@/lib/llm';
import { newRunId, recordLog, updateLogRecord } from '@/lib/logger';
import { toModelTabs } from '@/lib/model-input';
import { requestPlan } from '@/lib/run-plan';
import { auditSelection, dedupeEligibilityReason, selectionContextFromGroups } from '@/lib/selection';
import type { SelectionContext } from '@/lib/selection';
import { bridgeApi, createBridgePort, DEFAULT_UI_EXTENSION_ID } from '@/lib/stackbridge';
import type { BridgeRuntime, BridgeTabsApi } from '@/lib/stackbridge';
import { describeVivaldiSignals } from '@/lib/vivaldi';
import type { Browser } from 'wxt/browser';
import type { DedupeRecord, DedupeTabRecord, GroupingBackend, RunCall, RunRecord, SelectionRecord } from '@/lib/types';

export default defineBackground(() => {
  void reconcileOnStartup();

  let inFlight = false;

  browser.action.onClicked.addListener((tab) => {
    void run(tab.windowId);
  });

  async function run(windowId: number): Promise<void> {
    if (inFlight) return;

    const startedAt = Date.now();
    const record: RunRecord = {
      kind: 'run',
      id: newRunId(startedAt),
      ts: startedAt,
      outcome: 'success',
      durationMs: 0,
      windowId,
    };

    const config = await getConfig();
    if (!config?.apiKey) {
      // No-key runs are recorded too (outcome + reason, no payload), so "clicked
      // but nothing happened" is diagnosable from the log.
      record.outcome = 'error';
      record.reason = 'No API key configured.';
      await persist(record, startedAt);
      await browser.runtime.openOptionsPage();
      return;
    }

    inFlight = true;
    await setPending();
    // getConfig merges defaults, so dedupe settings are always present at runtime.
    const dedupeConfig = config.dedupe ?? { enabled: true, threshold: DEDUPE.threshold };
    try {
      // Detection is browser-wide and decides both the port and the dedupe default; Vivaldi-ness
      // is a property of the browser, and window/tab signals may live in any window.
      const [allTabs, allWindows] = await Promise.all([browser.tabs.query({}), browser.windows.getAll()]);
      const vivaldiSignals = describeVivaldiSignals(allTabs, navigator, allWindows);
      const isVivaldi = vivaldiSignals.signals.length > 0;
      if (isVivaldi) console.log(`${LOG_PREFIX} Vivaldi detected via: ${vivaldiSignals.signals.join(', ')}`);

      // Bridge-or-nothing on Vivaldi: an unreachable StackBridge mod blocks the whole run exactly
      // like a missing API key (grouping decision in docs/grouping-port.md).
      const setting: GroupingBackend = config.groupingBackend ?? 'auto';
      const uiExtensionId = config.bridge?.uiExtensionId?.trim() || DEFAULT_UI_EXTENSION_ID;
      // The single place WXT's browser types meet the wxt-free port layer; the casts live here so
      // every lib module (and every test) stays free of any browser environment.
      const bridge = createBridgePort(
        bridgeApi(browser.runtime as unknown as BridgeRuntime),
        uiExtensionId,
        () => (config.groupingBackend ?? 'auto') === 'stacks',
        browser.tabs as unknown as BridgeTabsApi,
      );
      const decision = await selectPort(
        { isVivaldi },
        setting,
        {
          native: nativePort(
            browser.tabs as unknown as NativeTabsApi,
            browser.tabGroups as unknown as NativeTabGroupsApi,
          ),
          bridge,
        },
      );
      if (decision.kind === 'blocked') {
        record.outcome = 'error';
        record.reason = decision.reason;
        record.probe = decision.probe;
        await clearBadge();
        await browser.runtime.openOptionsPage();
        return; // the run record is persisted by the finally block, like the skip path
      }
      const port = decision.port;
      record.backend = decision.backend;
      record.probe = decision.probe;

      const tabs = await browser.tabs.query({ windowId });
      // Authoritative visible-group membership for exclusion; read once per run, before dedupe —
      // stacked tabs are never dedupe-eligible, so nothing the pre-pass closes can invalidate it.
      const groups = await port.listGroups(windowId);
      const selectionContext = selectionContextFromGroups(groups, port.caps);

      let workingTabs = tabs;
      let dedupeClosed = 0;
      if (dedupeConfig.enabled) {
        // Vivaldi's groupId is not trustworthy (invisible and possibly stale), so the dedupe
        // grouped rule is dropped there by default; Chrome keeps trusting it (user groups).
        const ignoreGrouped = dedupeConfig.ignoreGrouped ?? !port.caps.nativeGroupsTrustworthy;
        dedupeClosed = await runDedupe(record, tabs, dedupeConfig.threshold, windowId, ignoreGrouped, selectionContext);
        if (dedupeClosed > 0) workingTabs = await browser.tabs.query({ windowId });
      }
      const audit = auditSelection(workingTabs, selectionContext);
      const candidates = audit.candidates;
      record.selectionId = await persistSelection(audit, windowId, record.id, decision.backend);
      console.log(`${LOG_PREFIX} ${candidates.length} candidate tabs in window ${windowId}`);
      if (candidates.length < LIMITS.minCandidates) {
        console.log(`${LOG_PREFIX} Skipped: fewer than ${LIMITS.minCandidates} candidates`);
        record.outcome = 'skip';
        record.reason = `Fewer than ${LIMITS.minCandidates} candidate tabs`;
        if (dedupeClosed > 0) await setClosedFlash(dedupeClosed);
        else await setSkip();
        return;
      }

      const modelTabs = toModelTabs(candidates);
      record.tabCount = modelTabs.length;
      console.log(`${LOG_PREFIX} Requesting grouping plan for ${modelTabs.length} tabs`);

      // Caller-owned calls array: completed calls are visible to the finally-block persist even
      // if a later call throws (same crash-diagnosability contract as before the extraction).
      const calls: RunCall[] = [];
      record.calls = calls;
      const { plans, errors } = await requestPlan(chatCompletion, config.apiKey, modelTabs, calls, config.model);
      if (errors.length > 0) {
        console.warn(`${LOG_PREFIX} Partial issues ignored:`, errors);
      }

      console.log(`${LOG_PREFIX} Plan: ${plans.length} groups`, plans);
      const report = await port.apply(plans, windowId);
      console.log(
        `${LOG_PREFIX} Applied ${report.applied}, skipped ${report.skipped}, failed ${report.failed} via ${report.backend}`,
        report.failures,
      );
      await clearLastError();
      if (dedupeClosed > 0) await setClosedFlash(dedupeClosed);
      else await clearBadge();
    } catch (e) {
      const message =
        e instanceof Error
          ? e.name === 'AbortError'
            ? `Request timed out after ${LIMITS.timeoutMs / 1000}s`
            : e.message
          : String(e);
      console.error(`${LOG_PREFIX} Run failed:`, message);
      record.outcome = 'error';
      record.error = message;
      await setLastError({ message, timestamp: Date.now() });
      await setError();
    } finally {
      inFlight = false;
      await persist(record, startedAt).catch((e) => {
        console.error(`${LOG_PREFIX} Failed to persist run log:`, e);
      });
    }
  }

  async function persist(record: RunRecord, startedAt: number): Promise<void> {
    record.durationMs = Date.now() - startedAt;
    await recordLog(record);
  }

  /**
   * Dedupe pre-pass: plan over eligible tabs, persist the record before any destructive action,
   * close, then verify actual outcomes (a declined beforeunload prompt leaves the tab open).
   * Returns how many tabs were actually removed.
   */
  async function runDedupe(
    record: RunRecord,
    tabs: Browser.tabs.Tab[],
    threshold: number,
    windowId: number,
    ignoreGrouped: boolean,
    selectionContext: SelectionContext,
  ): Promise<number> {
    const eligible = tabs.filter((t) => dedupeEligibilityReason(t, selectionContext, ignoreGrouped) == null);
    const plan = planDedupe(eligible, threshold);
    const tabById = new Map(eligible.map((t) => [t.id as number, t]));
    const entries: DedupeTabRecord[] = plan.entries.map((entry) => {
      const tab = tabById.get(entry.id)!;
      // DedupeEntry fields align with DedupeTabRecord, so the audit payload is a spread plus the tab facts.
      return { ...entry, url: tab.url ?? '', title: (tab.title ?? '').slice(0, LIMITS.titleMax), lastAccessed: tab.lastAccessed ?? 0 };
    });
    const dedupe: DedupeRecord = {
      kind: 'dedupe',
      id: newRunId(),
      ts: Date.now(),
      windowId,
      params: {
        threshold,
        weightPath: DEDUPE.weightPath,
        weightQuery: DEDUPE.weightQuery,
        substituteCost: DEDUPE.substituteCost,
        ignoreGrouped,
      },
      tabs: entries,
      plannedCloseCount: plan.closedIds.length,
      runId: record.id,
    };
    // Persist the plan before closing anything, so even a crash mid-close stays diagnosable.
    try {
      await recordLog(dedupe);
      record.dedupeId = dedupe.id;
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to persist dedupe log:`, e);
    }
    if (plan.closedIds.length === 0) return 0;
    try {
      await browser.tabs.remove(plan.closedIds);
    } catch (e) {
      console.warn(`${LOG_PREFIX} tabs.remove failed (some tabs may already be gone):`, e);
    }
    const survivors = new Set((await browser.tabs.query({ windowId })).map((t) => t.id as number));
    let closed = 0;
    for (const entry of dedupe.tabs) {
      if (entry.role !== 'closed') continue;
      entry.outcome = survivors.has(entry.id) ? 'declined' : 'removed';
      if (entry.outcome === 'removed') closed++;
    }
    dedupe.closedCount = closed;
    try {
      await updateLogRecord(dedupe);
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to backfill dedupe outcomes:`, e);
    }
    console.log(`${LOG_PREFIX} Dedupe closed ${closed}/${plan.closedIds.length} planned tabs`);
    return closed;
  }

  /** Write the selection audit before anything can fail, so skips/errors stay diagnosable. */
  async function persistSelection(
    audit: ReturnType<typeof auditSelection>,
    windowId: number,
    runId: string,
    backend: RunRecord['backend'],
  ): Promise<string | undefined> {
    const selected = audit.tabs.filter((t) => t.selected);
    const selection: SelectionRecord = {
      kind: 'selection',
      id: newRunId(),
      ts: Date.now(),
      windowId,
      tabs: audit.tabs,
      totalTabs: audit.tabs.length,
      selectedCount: selected.length,
      excludedCount: audit.tabs.length - selected.length,
      runId,
      backend,
    };
    try {
      await recordLog(selection);
      return selection.id;
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to persist selection log:`, e);
      return undefined;
    }
  }
});
