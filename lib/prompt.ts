import type { ChatMessage, ModelTab, ResponseSchemaSpec } from './types';

/**
 * Thin fixed system prompt: the role statement plus the output contract only. All grouping
 * policy lives in the user prompt segment (a prefill or custom text), so the contract below
 * doubles as the instruction set when the API-level schema is unavailable (see llm.ts fallback).
 */
export const SYSTEM_PROMPT = `You organize open browser tabs into groups, based on each tab's title and URL.
Rules:
- Output ONLY valid JSON. No markdown fences, no commentary.
- Schema: {"groups": [{"name": string, "tabIds": number[]}]}
- Use only ids from the input. Each id may appear in at most one group.
- Never create catch-all groups like "Other" or "Misc".`;

/** The plan shape as a strict structured-output spec, sent as response_format where supported. */
export const GROUPING_SCHEMA: ResponseSchemaSpec = {
  name: 'grouping_plan',
  schema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            tabIds: { type: 'array', items: { type: 'integer' } },
          },
          required: ['name', 'tabIds'],
          additionalProperties: false,
        },
      },
    },
    required: ['groups'],
    additionalProperties: false,
  },
};

export function buildMessages(candidates: ModelTab[], policy?: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  // The policy is its own user turn ahead of the tab payload, so the fixed contract and the
  // editable policy stay separately visible in the run logs.
  const trimmedPolicy = policy?.trim();
  if (trimmedPolicy) messages.push({ role: 'user', content: trimmedPolicy });
  messages.push({ role: 'user', content: JSON.stringify(candidates) });
  return messages;
}

export function buildRetryMessages(previous: ChatMessage[], rawResponse: string, errors: string[]): ChatMessage[] {
  return [
    ...previous,
    { role: 'assistant', content: rawResponse },
    {
      role: 'user',
      content: `Your previous output was invalid:\n- ${errors.join('\n- ')}\n\nReturn the corrected JSON only, following the schema exactly.`,
    },
  ];
}
