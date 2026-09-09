import { applyPlans } from '@/lib/apply-groups';
import { clearBadge, setError, setPending, setSkip, reconcileOnStartup } from '@/lib/badge';
import { clearLastError, getConfig, setLastError } from '@/lib/config';
import { LIMITS } from '@/lib/constants';
import { chatCompletion } from '@/lib/llm';
import { newRunId, recordLog } from '@/lib/logger';
import { toModelTabs } from '@/lib/model-input';
import { parsePlan } from '@/lib/parse-groups';
import { buildMessages, buildRetryMessages } from '@/lib/prompt';
import { auditSelection } from '@/lib/selection';
import type { RunCall, RunRecord, SelectionRecord } from '@/lib/types';

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
    try {
      const tabs = await browser.tabs.query({ windowId });
      const audit = auditSelection(tabs);
      const candidates = audit.candidates;
      record.selectionId = await persistSelection(audit, windowId, record.id);
      console.log(`${LOG_PREFIX} ${candidates.length} candidate tabs in window ${windowId}`);
      if (candidates.length < LIMITS.minCandidates) {
        console.log(`${LOG_PREFIX} Skipped: fewer than ${LIMITS.minCandidates} candidates`);
        record.outcome = 'skip';
        record.reason = `Fewer than ${LIMITS.minCandidates} candidate tabs`;
        await setSkip();
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
      await clearBadge();
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
