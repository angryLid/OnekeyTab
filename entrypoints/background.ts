import { applyPlans } from '@/lib/apply-groups';
import { clearBadge, setError, setPending, setSkip, reconcileOnStartup } from '@/lib/badge';
import { clearLastError, getConfig, setLastError } from '@/lib/config';
import { LIMITS } from '@/lib/constants';
import { chatCompletion } from '@/lib/llm';
import { toModelTabs } from '@/lib/model-input';
import { parsePlan } from '@/lib/parse-groups';
import { buildMessages, buildRetryMessages } from '@/lib/prompt';
import { selectCandidates } from '@/lib/selection';

const LOG_PREFIX = '[ai-tab-grouper]';

export default defineBackground(() => {
  void reconcileOnStartup();

  let inFlight = false;

  browser.action.onClicked.addListener((tab) => {
    void run(tab.windowId);
  });

  async function run(windowId: number): Promise<void> {
    if (inFlight) return;

    const config = await getConfig();
    if (!config?.apiKey) {
      await browser.runtime.openOptionsPage();
      return;
    }

    inFlight = true;
    const startedAt = Date.now();
    await setPending();
    try {
      const tabs = await browser.tabs.query({ windowId });
      const candidates = selectCandidates(tabs);
      console.log(`${LOG_PREFIX} ${candidates.length} candidate tabs in window ${windowId}`);
      if (candidates.length < LIMITS.minCandidates) {
        console.log(`${LOG_PREFIX} Skipped: fewer than ${LIMITS.minCandidates} candidates`);
        await setSkip();
        return;
      }

      const modelTabs = toModelTabs(candidates);
      const messages = buildMessages(modelTabs);
      console.log(`${LOG_PREFIX} Requesting grouping plan for ${modelTabs.length} tabs`);

      const first = await chatCompletion(config.apiKey, { messages });
      console.log(`${LOG_PREFIX} Model ${first.model} responded in ${Date.now() - startedAt}ms`);
      console.log(`${LOG_PREFIX} Raw response: ${first.content}`);

      const validIds = new Set(modelTabs.map((t) => t.id));
      let { plans, errors } = parsePlan(first.content, validIds);

      if (plans.length === 0 && errors.length > 0) {
        console.warn(`${LOG_PREFIX} Invalid plan, retrying once:`, errors);
        const retry = await chatCompletion(config.apiKey, {
          messages: buildRetryMessages(messages, first.content, errors),
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
      await setLastError({ message, timestamp: Date.now() });
      await setError();
    } finally {
      inFlight = false;
    }
  }
});
