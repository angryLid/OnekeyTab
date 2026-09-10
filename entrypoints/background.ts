import { applyPlans } from '@/lib/apply-groups';
import { clearBadge, setClosedFlash, setError, setPending, setSkip, reconcileOnStartup } from '@/lib/badge';
import { clearLastError, getConfig, setLastError } from '@/lib/config';
import { DEDUPE, LIMITS } from '@/lib/constants';
import { planDedupe } from '@/lib/dedupe';
import { chatCompletion } from '@/lib/llm';
import { newRunId, recordLog, updateLogRecord } from '@/lib/logger';
import { toModelTabs } from '@/lib/model-input';
import { parsePlan } from '@/lib/parse-groups';
import { buildMessages, buildRetryMessages } from '@/lib/prompt';
import { auditSelection, dedupeEligibilityReason } from '@/lib/selection';
import { describeVivaldiSignals } from '@/lib/vivaldi';
import type { Browser } from 'wxt/browser';
import type { DedupeRecord, DedupeTabRecord, RunCall, RunRecord, SelectionRecord } from '@/lib/types';

const LOG_PREFIX = '[ai-tab-grouper]';

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
      const tabs = await browser.tabs.query({ windowId });
      let workingTabs = tabs;
      let dedupeClosed = 0;
      if (dedupeConfig.enabled) {
        // Manual override wins; otherwise auto-detect Vivaldi, whose native tab groups render nowhere.
        // Detection is browser-wide: Vivaldi-ness is a property of the browser, and window/
        // tab signals may live in any window, not just this one.
        const [allTabs, allWindows] = await Promise.all([browser.tabs.query({}), browser.windows.getAll()]);
        const vivaldiSignals = describeVivaldiSignals(allTabs, navigator, allWindows);
        if (vivaldiSignals.signals.length > 0) {
          console.log(`${LOG_PREFIX} Vivaldi detected via: ${vivaldiSignals.signals.join(', ')}`);
        }
        const ignoreGrouped = dedupeConfig.ignoreGrouped ?? vivaldiSignals.signals.length > 0;
        dedupeClosed = await runDedupe(record, tabs, dedupeConfig.threshold, windowId, ignoreGrouped);
        if (dedupeClosed > 0) workingTabs = await browser.tabs.query({ windowId });
      }
      const audit = auditSelection(workingTabs);
      const candidates = audit.candidates;
      record.selectionId = await persistSelection(audit, windowId, record.id);
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
      const messages = buildMessages(modelTabs);
      record.tabCount = modelTabs.length;
      console.log(`${LOG_PREFIX} Requesting grouping plan for ${modelTabs.length} tabs`);

      const calls: RunCall[] = [];
      const firstStartedAt = Date.now();
      const first = await chatCompletion(config.apiKey, { messages });
      calls.push({
        ts: firstStartedAt,
        durationMs: Date.now() - firstStartedAt,
        model: first.model,
        request: messages,
        response: first.content,
      });
      record.calls = calls;
      console.log(`${LOG_PREFIX} Model ${first.model} responded in ${Date.now() - startedAt}ms`);
      console.log(`${LOG_PREFIX} Raw response: ${first.content}`);

      const validIds = new Set(modelTabs.map((t) => t.id));
      let { plans, errors } = parsePlan(first.content, validIds);

      if (plans.length === 0 && errors.length > 0) {
        console.warn(`${LOG_PREFIX} Invalid plan, retrying once:`, errors);
        calls[0]!.parseError = errors.join('; ');
        const retryStartedAt = Date.now();
        const retry = await chatCompletion(config.apiKey, {
          messages: buildRetryMessages(messages, first.content, errors),
        });
        calls.push({
          ts: retryStartedAt,
          durationMs: Date.now() - retryStartedAt,
          model: retry.model,
          request: buildRetryMessages(messages, first.content, errors),
          response: retry.content,
        });
        console.log(`${LOG_PREFIX} Retry raw response: ${retry.content}`);
        ({ plans, errors } = parsePlan(retry.content, validIds));
        if (plans.length === 0 && errors.length > 0) {
          throw new Error(`Model returned invalid grouping twice: ${errors.join('; ')}`);
        }
      }
      if (errors.length > 0) {
        console.warn(`${LOG_PREFIX} Partial issues ignored:`, errors);
      }

      console.log(`${LOG_PREFIX} Plan: ${plans.length} groups`, plans);
      const report = await applyPlans(plans, windowId);
      console.log(
        `${LOG_PREFIX} Applied ${report.applied}, skipped ${report.skipped}, failed ${report.failed}`,
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
  ): Promise<number> {
    const eligible = tabs.filter((t) => dedupeEligibilityReason(t, ignoreGrouped) == null);
    const plan = planDedupe(eligible, threshold);
    const tabById = new Map(eligible.map((t) => [t.id as number, t]));
    const entries: DedupeTabRecord[] = plan.entries.map((entry) => {
      const tab = tabById.get(entry.tabId)!;
      const tabRec: DedupeTabRecord = {
        id: entry.tabId,
        url: tab.url ?? '',
        title: (tab.title ?? '').slice(0, LIMITS.titleMax),
        lastAccessed: tab.lastAccessed ?? 0,
        role: entry.role,
      };
      if (entry.score != null) {
        tabRec.score = entry.score;
        tabRec.baselineId = entry.baselineId;
      }
      return tabRec;
    });
    const dedupe: DedupeRecord = {
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
  ): Promise<string | undefined> {
    const selected = audit.tabs.filter((t) => t.selected);
    const selection: SelectionRecord = {
      id: newRunId(),
      ts: Date.now(),
      windowId,
      tabs: audit.tabs,
      totalTabs: audit.tabs.length,
      selectedCount: selected.length,
      excludedCount: audit.tabs.length - selected.length,
      runId,
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
