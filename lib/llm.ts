import { LIMITS, PROVIDERS } from './constants';
import type { ChatMessage, ChatResult } from './types';

export interface CompletionOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}

async function postChat(apiKey: string, opts: CompletionOptions): Promise<Record<string, unknown>> {
  const provider = PROVIDERS.openrouter;
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
      body: JSON.stringify({
        model: provider.model,
        messages: opts.messages,
        temperature: LIMITS.temperature,
        max_tokens: opts.maxTokens ?? LIMITS.maxTokens,
        provider: { sort: 'throughput' },
      }),
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
      throw new Error(`OpenRouter request failed (${res.status}): ${message.slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function chatCompletion(apiKey: string, opts: CompletionOptions): Promise<ChatResult> {
  const data = await postChat(apiKey, opts);
  const choices = (data.choices as Array<{ message?: { content?: unknown } }> | undefined) ?? [];
  const content = choices[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('OpenRouter returned no message content.');
  return { content, model: (data.model as string | undefined) ?? 'unknown' };
}

export async function verifyApiKey(apiKey: string): Promise<void> {
  await postChat(apiKey, {
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 1,
  });
}
