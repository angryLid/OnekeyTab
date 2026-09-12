import { LIMITS, PROVIDERS } from './constants';
import type { ChatMessage, ChatResult } from './types';

export interface CompletionOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Reasoning tokens count as output tokens, so the request asks for the lowest supported level.
 * There is no universal minimum: mandated-reasoning endpoints reject the parameter outright
 * (z-ai/glm-5.3-flash: 400 "Reasoning is mandatory and cannot be disabled"), while some
 * gateway-routed models accept the parameter but may still emit some reasoning content.
 * On rejection we remember it and retry once without the parameter; the raised max_tokens
 * budget keeps the final answer room either way.
 */
let reasoningParamUnsupported = false;

/** Test hook: the endpoint quirk memory must not leak between test cases or builds. */
export function resetReasoningParamSupport(): void {
  reasoningParamUnsupported = false;
}

function buildBody(opts: CompletionOptions, includeReasoning: boolean): Record<string, unknown> {
  const provider = PROVIDERS.openrouter;
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: opts.messages,
    temperature: LIMITS.temperature,
    max_tokens: opts.maxTokens ?? LIMITS.maxTokens,
    provider: { sort: 'throughput' },
  };
  if (includeReasoning) body.reasoning = { effort: 'minimal' };
  return body;
}

async function postChat(apiKey: string, opts: CompletionOptions): Promise<Record<string, unknown>> {
  const provider = PROVIDERS.openrouter;
  for (let attempt = 0; attempt < 2; attempt++) {
    // First attempt asks to disable reasoning; a rejecting endpoint gets exactly one param-less retry.
    const includeReasoning = attempt === 0 && !reasoningParamUnsupported;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? LIMITS.timeoutMs);
    try {
      const res = await fetch(provider.baseUrl + provider.chatPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...provider.extraHeaders,
        },
        body: JSON.stringify(buildBody(opts, includeReasoning)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        let message = text;
        try {
          message = ((JSON.parse(text) as { error?: { message?: string } }).error?.message as string) ?? text;
        } catch {
          // Keep the raw body as the message.
        }
        if (res.status === 400 && includeReasoning && /reasoning/i.test(message)) {
          reasoningParamUnsupported = true;
          continue;
        }
        throw new Error(`OpenRouter request failed (${res.status}): ${message.slice(0, 300)}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('OpenRouter request failed: reasoning-parameter fallback exhausted.');
}

export async function chatCompletion(apiKey: string, opts: CompletionOptions): Promise<ChatResult> {
  const data = await postChat(apiKey, opts);
  const choices = (data.choices as Array<{ message?: { content?: unknown }; finish_reason?: unknown }> | undefined) ?? [];
  const message = choices[0]?.message;
  if (typeof message?.content !== 'string' || message.content.length === 0) {
    // Empty content with a 200 response usually means a thinking model spent its whole output
    // budget on reasoning; finish_reason and a raw snippet make that diagnosable from the log.
    const finish = choices[0]?.finish_reason;
    const finishLabel = finish == null ? 'unknown' : String(finish);
    const raw = JSON.stringify(data) ?? '';
    throw new Error(`OpenRouter returned no message content (finish_reason: ${finishLabel}; raw: ${raw.slice(0, 300)})`);
  }
  return { content: message.content, model: (data.model as string | undefined) ?? 'unknown' };
}

export async function verifyApiKey(apiKey: string): Promise<void> {
  await postChat(apiKey, {
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 1,
  });
}
