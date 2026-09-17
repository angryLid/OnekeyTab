import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion, resetReasoningParamSupport, resetStructuredOutputSupport, verifyApiKey } from './llm';
import type { ChatMessage, ResponseSchemaSpec } from './types';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'tabs json' }];
const SCHEMA: ResponseSchemaSpec = { name: 'grouping_plan', schema: { type: 'object' } };
const CHOICES = { choices: [{ message: { content: '{"groups":[]}' }, finish_reason: 'stop' }], model: 'test-model' };

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  resetReasoningParamSupport();
  resetStructuredOutputSupport();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chatCompletion structured outputs', () => {
  it('sends response_format json_schema and require_parameters routing when a schema is given', async () => {
    const fetchMock = vi.fn(async () => okJson(CHOICES));
    vi.stubGlobal('fetch', fetchMock);

    await chatCompletion('key', { messages: MESSAGES, responseSchema: SCHEMA });

    const body = sentBody(fetchMock, 0);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'grouping_plan', schema: { type: 'object' }, strict: true },
    });
    expect(body.provider).toEqual({ sort: 'throughput', require_parameters: true });
  });

  it('retries once without the schema when the endpoint rejects it, then remembers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail(400, 'response_format is not supported for this model'))
      // A factory, not mockResolvedValue: a single Response instance cannot be read twice.
      .mockImplementation(async () => okJson(CHOICES));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion('key', { messages: MESSAGES, responseSchema: SCHEMA });
    expect(result.content).toBe('{"groups":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1).response_format).toBeUndefined();
    expect(sentBody(fetchMock, 1).provider).toEqual({ sort: 'throughput' });

    // The quirk is remembered: the next call skips the schema variant immediately.
    await chatCompletion('key', { messages: MESSAGES, responseSchema: SCHEMA });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(fetchMock, 2).response_format).toBeUndefined();
  });

  it('never sends the schema outside plan calls (key verification stays a plain ping)', async () => {
    const fetchMock = vi.fn(async () => okJson(CHOICES));
    vi.stubGlobal('fetch', fetchMock);

    await verifyApiKey('key');

    const body = sentBody(fetchMock, 0);
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toEqual({ sort: 'throughput' });
  });
});
