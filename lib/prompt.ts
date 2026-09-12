import { LIMITS } from './constants';
import type { ChatMessage, ModelTab } from './types';

export const SYSTEM_PROMPT = `You organize browser tabs into groups. You receive a JSON array of open tabs, each with an "id" (number), a "title" (string), and a "url" (string). Group tabs that clearly share a topic, such as the same website, the same project, or the same task.

Rules:
- Output ONLY valid JSON. No markdown fences, no commentary, no explanation.
- Schema: {"groups": [{"name": string, "tabIds": number[]}]}
- Use only ids from the input. Each id may appear in at most one group.
- Only group tabs that belong together. Leave unrelated tabs out. Never create catch-all groups like "Other" or "Misc".
- Group names must be in the same language as the tab titles, at most ${LIMITS.nameMax} characters.
- Only create groups containing 2 or more tabs. Typically produce 2 to 8 groups.
- If nothing groups naturally, return {"groups": []}.`;

export function buildMessages(candidates: ModelTab[]): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(candidates) },
  ];
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
