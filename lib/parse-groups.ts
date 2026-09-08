import { LIMITS } from './constants';
import type { GroupPlan, ParseResult } from './types';

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match?.[1] ?? trimmed;
}

function extractGroups(raw: string): { groups: unknown[] | null; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (e) {
    return { groups: null, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (Array.isArray(parsed)) return { groups: parsed };
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { groups?: unknown }).groups)) {
    return { groups: (parsed as { groups: unknown[] }).groups };
  }
  return { groups: null, error: 'Response is not an array and not a { "groups": [...] } object.' };
}

export function parsePlan(raw: string, validIds: Set<number>): ParseResult {
  const { groups, error } = extractGroups(raw);
  if (error || groups === null) return { plans: [], errors: [error ?? 'No groups found in response.'] };

  const errors: string[] = [];
  const used = new Set<number>();
  const byName = new Map<string, GroupPlan>();

  for (const entry of groups) {
    if (entry === null || typeof entry !== 'object') {
      errors.push('Group entry is not an object; skipped.');
      continue;
    }
    const group = entry as { name?: unknown; tabIds?: unknown };
    const name = typeof group.name === 'string' ? group.name.trim().slice(0, LIMITS.nameMax) : '';
    if (!name) {
      errors.push('Group without a valid name; skipped.');
      continue;
    }
    const ids: number[] = [];
    for (const id of Array.isArray(group.tabIds) ? group.tabIds : []) {
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        errors.push(`Non-integer tabId ${JSON.stringify(id)} skipped.`);
        continue;
      }
      if (!validIds.has(id)) {
        errors.push(`Unknown tabId ${id} skipped.`);
        continue;
      }
      if (used.has(id)) {
        errors.push(`Duplicate tabId ${id} skipped (already assigned to another group).`);
        continue;
      }
      used.add(id);
      ids.push(id);
    }
    if (ids.length === 0) {
      errors.push(`Group "${name}" has no valid tabIds; skipped.`);
      continue;
    }
    const existing = byName.get(name);
    if (existing) existing.tabIds.push(...ids);
    else byName.set(name, { name, tabIds: ids });
  }

  const plans: GroupPlan[] = [];
  for (const plan of byName.values()) {
    if (plan.tabIds.length < 2) {
      errors.push(`Group "${plan.name}" has fewer than 2 valid tabs; dropped.`);
      continue;
    }
    plans.push(plan);
  }
  return { plans, errors };
}
