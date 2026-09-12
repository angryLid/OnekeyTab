// Wxt-free: the chat transport is injected, so the call+parse+retry contract tests without a browser.
import { LOG_PREFIX } from './constants';
import { parsePlan } from './parse-groups';
import { buildMessages, buildRetryMessages } from './prompt';
import type { ChatMessage, ChatResult, GroupPlan, ModelTab, RunCall } from './types';

/** The slice of the LLM client requestPlan needs; structural so tests inject fakes. */
export type ChatFn = (apiKey: string, opts: { messages: ChatMessage[]; model?: string }) => Promise<ChatResult>;

export interface PlanOutcome {
  plans: GroupPlan[];
  /** Parse issues that did not invalidate the plan; the caller decides whether to surface them. */
  errors: string[];
}

/**
 * One model round trip plus the single invalid-plan retry: call, parse, and on a fully invalid
 * plan retry once with the errors fed back, then parse again. `calls` is caller-owned and filled
 * progressively so the composition root can persist completed calls even when a later call throws.
 * Throws when the model returns an invalid plan twice; partial errors on a usable plan are returned, never thrown.
 */
export async function requestPlan(
  chat: ChatFn,
  apiKey: string,
  candidates: ModelTab[],
  calls: RunCall[],
  model?: string,
): Promise<PlanOutcome> {
  const messages = buildMessages(candidates);
  const validIds = new Set(candidates.map((tab) => tab.id));

  const firstStartedAt = Date.now();
  const first = await chat(apiKey, { messages, model });
  calls.push({
    ts: firstStartedAt,
    durationMs: Date.now() - firstStartedAt,
    model: first.model,
    request: messages,
    response: first.content,
  });
  console.log(`${LOG_PREFIX} Model ${first.model} responded in ${calls[0]!.durationMs}ms`);
  console.log(`${LOG_PREFIX} Raw response: ${first.content}`);

  let { plans, errors } = parsePlan(first.content, validIds);

  if (plans.length === 0 && errors.length > 0) {
    console.warn(`${LOG_PREFIX} Invalid plan, retrying once:`, errors);
    calls[0]!.parseError = errors.join('; ');
    const retryMessages = buildRetryMessages(messages, first.content, errors);
    const retryStartedAt = Date.now();
    const retry = await chat(apiKey, { messages: retryMessages, model });
    calls.push({
      ts: retryStartedAt,
      durationMs: Date.now() - retryStartedAt,
      model: retry.model,
      request: retryMessages,
      response: retry.content,
    });
    console.log(`${LOG_PREFIX} Retry raw response: ${retry.content}`);
    ({ plans, errors } = parsePlan(retry.content, validIds));
    if (plans.length === 0 && errors.length > 0) {
      throw new Error(`Model returned invalid grouping twice: ${errors.join('; ')}`);
    }
  }
  return { plans, errors };
}
