import { describe, expect, it } from 'vitest';
import { GROUPING_SCHEMA, SYSTEM_PROMPT, buildMessages } from './prompt';
import type { ModelTab } from './types';

const TABS: ModelTab[] = [
  { id: 1, title: 'A', url: 'https://a.example/' },
  { id: 2, title: 'B', url: 'https://b.example/' },
];

describe('buildMessages', () => {
  it('sends system + tab payload when no policy is set', () => {
    const messages = buildMessages(TABS);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
    expect(messages[1]?.content).toBe(JSON.stringify(TABS));
  });

  it('inserts a trimmed policy user turn ahead of the tab payload', () => {
    const messages = buildMessages(TABS, '  Group per ticket.  ');
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'user', content: 'Group per ticket.' });
    expect(messages[2]?.content).toBe(JSON.stringify(TABS));
  });
});

describe('SYSTEM_PROMPT', () => {
  it('carries only the role and the output contract, no grouping policy', () => {
    expect(SYSTEM_PROMPT).toMatch(/organize open browser tabs into groups/);
    expect(SYSTEM_PROMPT).toMatch(/Output ONLY valid JSON/);
    expect(SYSTEM_PROMPT).not.toMatch(/website|ticket|task|gitlab|atlassian|language/i);
  });
});

describe('GROUPING_SCHEMA', () => {
  it('requires groups and forbids extra properties, matching the parse-side contract', () => {
    expect(GROUPING_SCHEMA.name).toBe('grouping_plan');
    expect(GROUPING_SCHEMA.schema.required).toEqual(['groups']);
    expect(GROUPING_SCHEMA.schema.additionalProperties).toBe(false);
  });
});
