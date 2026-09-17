import { LIMITS, PROVIDERS, isValidModelId, resolveModel } from './constants';
import type { ChatMessage, ChatResult, ResponseSchemaSpec } from './types';

export interface CompletionOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  /** Model id override; absent/empty falls back to the built-in provider default. */
  model?: string;
  /** Structured-output spec; when set, the request carries response_format json_schema and require_parameters routing. */
  responseSchema?: ResponseSchemaSpec;
}

/**
 * Reasoning tokens count as output tokens, so the request asks for the lowest supported level.
 * There is no universal minimum: mandated-reasoning endpoints reject the parameter outright
 * (z-ai/glm-5.3-flash: 400 "Reasoning is mandatory and cannot be disabled"), while some
 * gateway-routed models accept the parameter but may still emit some reasoning content.
 * On rejection we remember it and retry once without the parameter; the raised max_tokens
 * budget keeps the final answer room either way.
 */
// Single provider today: llm.ts reads this one entry and nothing else. When a second provider
// becomes real, thread Config.provider through chatCompletion instead of growing this list blind.
const PROVIDER = PROVIDERS.openrouter;

let reasoningParamUnsupported = false;
let structuredOutputUnsupported = false;

/** Test hook: the endpoint quirk memories must not leak between test cases or builds. */
export function resetReasoningParamSupport(): void {
  reasoningParamUnsupported = false;
}

/** Test hook: resets the structured-output fallback memory set by a rejecting endpoint. */
export function resetStructuredOutputSupport(): void {
  structuredOutputUnsupported = false;
}

/** Error signatures that mean "this model/endpoint cannot do response_format json_schema"; a plain retry is the answer. */
const STRUCTURED_UNSUPPORTED_RE = /response_format|json_schema|structured|no allowed providers|no providers/i;

function buildBody(opts: CompletionOptions, includeReasoning: boolean, includeStructured: boolean): Record<string, unknown> {
  // resolveModel also guards against a whitespace/oversized id slipping into a request.
  const model = isValidModelId(resolveModel(opts.model)) ? resolveModel(opts.model) : PROVIDER.model;
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: LIMITS.temperature,
    max_tokens: opts.maxTokens ?? LIMITS.maxTokens,
    // require_parameters keeps the schema meaningful: routing only picks endpoints that honor response_format.
    provider: includeStructured ? { sort: 'throughput', require_parameters: true } : { sort: 'throughput' },
  };
  if (includeReasoning) body.reasoning = { effort: 'minimal' };
  if (includeStructured && opts.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: opts.responseSchema.name, schema: opts.responseSchema.schema, strict: true },
    };
  }
  return body;
}

async function postChat(apiKey: string, opts: CompletionOptions): Promise<Record<string, unknown>> {
  // Worst case walks three variants: reasoning+schema, schema only, plain. Each rejecting
  // endpoint quirk is remembered and dropped for the rest of the session.
  for (let attempt = 0; attempt < 3; attempt++) {
    const includeReasoning = attempt === 0 && !reasoningParamUnsupported;
    const includeStructured = opts.responseSchema != null && !structuredOutputUnsupported;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? LIMITS.timeoutMs);
    try {
      const res = await fetch(PROVIDER.baseUrl + PROVIDER.chatPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...PROVIDER.extraHeaders,
        },
        body: JSON.stringify(buildBody(opts, includeReasoning, includeStructured)),
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
        // A schema-rejecting endpoint fails loudly (never silently ignores), so one plain retry restores today's behavior.
        if (includeStructured && (res.status === 400 || res.status === 404) && STRUCTURED_UNSUPPORTED_RE.test(message)) {
          structuredOutputUnsupported = true;
          continue;
        }
        throw new Error(`OpenRouter request failed (${res.status}): ${message.slice(0, 300)}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('OpenRouter request failed: parameter fallbacks exhausted.');
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

export async function verifyApiKey(apiKey: string, model?: string): Promise<void> {
  await postChat(apiKey, {
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 1,
    model,
  });
}
