import { describe, expect, it } from 'vitest';
import { parsePlan } from './parse-groups';

const validIds = new Set([1, 2, 3, 4, 5, 6]);

describe('parsePlan (happy path)', () => {
  it('parses a clean { groups: [...] } response', () => {
    const raw = JSON.stringify({
      groups: [
        { name: 'Dev', tabIds: [1, 2] },
        { name: '购物', tabIds: [3, 4, 5] },
      ],
    });
    const { plans, errors } = parsePlan(raw, validIds);
    expect(errors).toEqual([]);
    expect(plans).toEqual([
      { name: 'Dev', tabIds: [1, 2] },
      { name: '购物', tabIds: [3, 4, 5] },
    ]);
  });

  it('strips markdown fences', () => {
    const raw = '```json\n{"groups": [{"name": "Dev", "tabIds": [1, 2]}]}\n```';
    const { plans, errors } = parsePlan(raw, validIds);
    expect(errors).toEqual([]);
    expect(plans).toEqual([{ name: 'Dev', tabIds: [1, 2] }]);
  });

  it('accepts a bare top-level array', () => {
    const raw = JSON.stringify([{ name: 'Dev', tabIds: [1, 2] }]);
    const { plans, errors } = parsePlan(raw, validIds);
    expect(errors).toEqual([]);
    expect(plans).toEqual([{ name: 'Dev', tabIds: [1, 2] }]);
  });

  it('drops unknown ids and rejects groups left with fewer than 2 tabs', () => {
    const raw = JSON.stringify({ groups: [{ name: 'Dev', tabIds: [1, 99] }] });
    const { plans, errors } = parsePlan(raw, validIds);
    expect(plans).toEqual([]);
    expect(errors.some((e) => e.includes('Unknown tabId 99'))).toBe(true);
    expect(errors.some((e) => e.includes('fewer than 2'))).toBe(true);
  });

  it('dedupes ids across groups (first occurrence wins)', () => {
    const raw = JSON.stringify({
      groups: [
        { name: 'Dev', tabIds: [1, 2] },
        { name: 'News', tabIds: [2, 3] },
      ],
    });
    const { plans, errors } = parsePlan(raw, validIds);
    expect(errors.some((e) => e.includes('Duplicate tabId 2'))).toBe(true);
    expect(plans).toEqual([
      { name: 'Dev', tabIds: [1, 2] },
      { name: 'News', tabIds: [3] },
    ].filter((p) => p.tabIds.length >= 2));
  });

  it('merges groups with the same name', () => {
    const raw = JSON.stringify({
      groups: [
        { name: 'Dev', tabIds: [1, 2] },
        { name: 'Dev', tabIds: [3, 4] },
      ],
    });
    const { plans, errors } = parsePlan(raw, validIds);
    expect(errors).toEqual([]);
    expect(plans).toEqual([{ name: 'Dev', tabIds: [1, 2, 3, 4] }]);
  });

  it('treats an empty groups array as a legitimate success', () => {
    const { plans, errors } = parsePlan('{"groups": []}', validIds);
    expect(plans).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('truncates names to 24 characters', () => {
    const raw = JSON.stringify({ groups: [{ name: 'x'.repeat(50), tabIds: [1, 2] }] });
    const { plans } = parsePlan(raw, validIds);
    expect(plans[0]?.name).toHaveLength(24);
  });

  it('reports invalid JSON as errors', () => {
    const { plans, errors } = parsePlan('Sure! Here are your groups: ...', validIds);
    expect(plans).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
