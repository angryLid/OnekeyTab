import { describe, expect, it } from 'vitest';
import { GROUPING_SCHEMA } from './prompt';
import { requestPlan } from './run-plan';
import type { ChatMessage, ChatResult, ModelTab, ResponseSchemaSpec, RunCall } from './types';

const TABS: ModelTab[] = [
  { id: 1, title: 'A', url: 'https://a.example/' },
  { id: 2, title: 'B', url: 'https://b.example/' },
];

interface SentCall {
  apiKey: string;
  opts: { messages: ChatMessage[]; model?: string; responseSchema?: ResponseSchemaSpec };
}

function chatSequential(contents: string[]): { calls: SentCall[]; chat: Parameters<typeof requestPlan>[0] } {
  const calls: SentCall[] = [];
  const chat = async (apiKey: string, opts: { messages: ChatMessage[]; model?: string; responseSchema?: ResponseSchemaSpec }): Promise<ChatResult> => {
    calls.push({ apiKey, opts });
    return { content: contents[calls.length - 1] ?? '', model: 'test-model' };
  };
  return { calls, chat };
}

describe('requestPlan policy threading', () => {
  it('sends the policy as its own user turn ahead of the tab payload, with the schema', async () => {
    const { calls, chat } = chatSequential(['{"groups":[]}']);
    const runCalls: RunCall[] = [];

    await requestPlan(chat, 'key', TABS, runCalls, undefined, '  Group per ticket.  ');

    const { messages, responseSchema } = calls[0]!.opts;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'Group per ticket.' });
    expect(messages[2]?.content).toBe(JSON.stringify(TABS));
    expect(responseSchema).toEqual(GROUPING_SCHEMA);
  });

  it('omits the policy turn when it is blank', async () => {
    const { calls, chat } = chatSequential(['{"groups":[]}']);
    const runCalls: RunCall[] = [];

    await requestPlan(chat, 'key', TABS, runCalls, undefined, '   ');

    expect(calls[0]!.opts.messages).toHaveLength(2);
  });

  it('carries the policy and schema into the invalid-plan retry call', async () => {
    const { calls, chat } = chatSequential(['nope', '{"groups":[{"name":"G","tabIds":[1,2]}]}']);
    const runCalls: RunCall[] = [];

    const { plans } = await requestPlan(chat, 'key', TABS, runCalls, undefined, 'Group per ticket.');

    expect(calls).toHaveLength(2);
    expect(calls[1]!.opts.messages).toHaveLength(5);
    expect(calls[1]!.opts.messages[1]).toEqual({ role: 'user', content: 'Group per ticket.' });
    expect(calls[1]!.opts.responseSchema).toEqual(GROUPING_SCHEMA);
    expect(plans).toEqual([{ name: 'G', tabIds: [1, 2] }]);
  });
});
