import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyStackPlans,
  applyVivExtDataKeys,
  parseVivExtData,
  probeStackSupport,
  resetProbeCache,
  stackIdOf,
  STACK_FIELDS,
  unstackTabs,
} from './vivaldi-stacks';
import type { StackApi, StackTab } from './vivaldi-stacks';

interface FakeTab extends StackTab {
  windowId?: number;
  pinned?: boolean;
  url?: string;
  title?: string;
}

interface FakeOptions {
  /** Created probe tabs get no vivExtData, simulating a non-Vivaldi browser. */
  createWithoutVivExtData?: boolean;
  /** tabs.update resolves but silently drops vivExtData, simulating an ignored write. */
  dropVivExtDataOnUpdate?: boolean;
  /** Every tabs.update throws. */
  failAllUpdates?: boolean;
}

function fakeApi(initial: FakeTab[] = [], options: FakeOptions = {}) {
  const store = new Map<number, FakeTab>();
  let nextId = 1000;
  for (const tab of initial) {
    if (tab.id != null) store.set(tab.id, { ...tab });
  }
  const calls = {
    created: 0,
    updates: [] as Array<{ tabId: number; vivExtData: string }>,
    removed: [] as number[],
    ungrouped: number[][],
  };
  const api: StackApi = {
    async query(info) {
      let list = [...store.values()];
      if (info.windowId != null) list = list.filter((t) => t.windowId === info.windowId);
      return list.map((t) => ({ ...t }));
    },
    async get(tabId) {
      const tab = store.get(tabId);
      if (!tab) throw new Error(`No tab with id ${tabId}`);
      return { ...tab };
    },
    async create() {
      calls.created++;
      const id = nextId++;
      const tab: FakeTab = { id };
      if (!options.createWithoutVivExtData) tab.vivExtData = '{"seed":1}';
      store.set(id, tab);
      return { id };
    },
    async update(tabId, props) {
      const tab = store.get(tabId);
      if (!tab) throw new Error(`No tab with id ${tabId}`);
      if (options.failAllUpdates) throw new Error('update rejected');
      if (options.dropVivExtDataOnUpdate) return { ...tab };
      tab.vivExtData = props.vivExtData;
      calls.updates.push({ tabId, vivExtData: props.vivExtData });
      return { ...tab };
    },
    async remove(tabId) {
      store.delete(tabId);
      calls.removed.push(tabId);
    },
    async ungroup(tabIds) {
      for (const id of tabIds) {
        const tab = store.get(id);
        if (tab) delete tab.groupId;
      }
      calls.ungrouped.push([...tabIds]);
    },
  };
  return { api, store, calls };
}

function tab(id: number, windowId = 1, extra: Partial<FakeTab> = {}): FakeTab {
  return { id, windowId, url: `https://example.com/${id}`, title: `T${id}`, ...extra };
}

describe('parseVivExtData', () => {
  it('parses a JSON string into an object', () => {
    expect(parseVivExtData('{"a":1}')).toEqual({ a: 1 });
  });

  it('accepts an object defensively and rejects non-objects and malformed input', () => {
    expect(parseVivExtData({ a: 1 })).toEqual({ a: 1 });
    expect(parseVivExtData('not json')).toBeNull();
    expect(parseVivExtData('null')).toBeNull();
    expect(parseVivExtData('[1,2]')).toBeNull();
    expect(parseVivExtData('3')).toBeNull();
    expect(parseVivExtData('')).toBeNull();
    expect(parseVivExtData(undefined)).toBeNull();
    expect(parseVivExtData(null)).toBeNull();
  });
});

describe('applyVivExtDataKeys', () => {
  it('assigns keys while preserving unknown Vivaldi state', () => {
    const next = applyVivExtDataKeys('{"workspaceId":42,"fixedTitle":"keep"}', {
      assign: { group: 'g1', fixedGroupTitle: 'News' },
    });
    expect(JSON.parse(next)).toEqual({ workspaceId: 42, fixedTitle: 'keep', group: 'g1', fixedGroupTitle: 'News' });
  });

  it('deletes keys and supports assign+delete together', () => {
    const raw = '{"group":"g1","groupColor":"color3","fixedGroupTitle":"Old","workspaceId":7}';
    expect(JSON.parse(applyVivExtDataKeys(raw, { deleteKeys: STACK_FIELDS }))).toEqual({ workspaceId: 7 });
    const both = applyVivExtDataKeys(raw, { assign: { group: 'g2' }, deleteKeys: ['groupColor'] });
    expect(JSON.parse(both)).toEqual({ group: 'g2', fixedGroupTitle: 'Old', workspaceId: 7 });
  });

  it('throws on unparseable input so callers never stringify away Vivaldi state', () => {
    expect(() => applyVivExtDataKeys('not json', { assign: { a: 1 } })).toThrow();
  });
});

describe('stackIdOf', () => {
  it('returns the group id for stack members and null otherwise', () => {
    expect(stackIdOf({ vivExtData: '{"group":"s-1"}' })).toBe('s-1');
    expect(stackIdOf({ vivExtData: '{"group":""}' })).toBeNull();
    expect(stackIdOf({ vivExtData: '{"workspaceId":1}' })).toBeNull();
    expect(stackIdOf({})).toBeNull();
    expect(stackIdOf({ vivExtData: 'broken' })).toBeNull();
  });
});

describe('probeStackSupport', () => {
  beforeEach(() => resetProbeCache());

  it('passes the round-trip on a Vivaldi-like browser and cleans up the probe tab', async () => {
    const { api, calls } = fakeApi();
    const result = await probeStackSupport(api);
    expect(result).toEqual({ supported: true });
    expect(calls.created).toBe(1);
    expect(calls.removed).toHaveLength(1);
  });

  it('reports write-rejected when the write is ignored (plain Chromium semantics)', async () => {
    // No vivExtData on the fresh tab AND updates silently drop the field: exactly what a
    // plain Chromium build does with an unknown tabs.update property.
    const { api } = fakeApi([], { createWithoutVivExtData: true, dropVivExtDataOnUpdate: true });
    const result = await probeStackSupport(api);
    expect(result).toEqual({ supported: false, reason: 'write-rejected' });
  });

  it('does not require pre-attached vivExtData: a late/no field with working writes still passes (H7)', async () => {
    const { api } = fakeApi([], { createWithoutVivExtData: true });
    const result = await probeStackSupport(api);
    expect(result).toEqual({ supported: true });
  });

  it('retries the vivExtData read a few times before giving up on the laggy attach', async () => {
    const { api } = fakeApi();
    // Freshly created tabs start without vivExtData for the first two reads, like a slow attach.
    let reads = 0;
    const inner = api.get.bind(api);
    api.get = async (tabId) => {
      const result = await inner(tabId);
      if (result.vivExtData == null && reads < 2) {
        reads++;
        return { ...result };
      }
      if (result.vivExtData == null) result.vivExtData = '{"seed":1}';
      return result;
    };
    const result = await probeStackSupport(api);
    expect(result).toEqual({ supported: true });
  });

  it('reports write-rejected when the update resolves but does not persist', async () => {
    const { api } = fakeApi([], { dropVivExtDataOnUpdate: true });
    const result = await probeStackSupport(api);
    expect(result).toEqual({ supported: false, reason: 'write-rejected' });
  });

  it('reports error with the message when the write throws', async () => {
    const { api } = fakeApi([], { failAllUpdates: true });
    const result = await probeStackSupport(api);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.detail).toBe('update rejected');
  });

  it('memoizes one probe per lifetime unless forced', async () => {
    const { api, calls } = fakeApi();
    await probeStackSupport(api);
    await probeStackSupport(api);
    expect(calls.created).toBe(1);
    await probeStackSupport(api, true);
    expect(calls.created).toBe(2);
  });
});

describe('applyStackPlans', () => {
  it('writes a shared group id and the plan title, preserving unknown keys', async () => {
    const { api, store, calls } = fakeApi([
      tab(1, 1, { vivExtData: '{"workspaceId":42}' }),
      tab(2, 1, { vivExtData: { workspaceId: 43 } }), // object form (older builds) survives too
    ]);
    const report = await applyStackPlans([{ name: 'News', tabIds: [1, 2] }], 1, api);
    expect(report).toMatchObject({ applied: 1, skipped: 0, failed: 0, backend: 'stacks' });
    const first = JSON.parse(String(store.get(1)?.vivExtData));
    const second = JSON.parse(String(store.get(2)?.vivExtData));
    expect(first.workspaceId).toBe(42);
    expect(second.workspaceId).toBe(43);
    expect(first.group).toBe(second.group);
    expect(first.fixedGroupTitle).toBe('News');
    expect(calls.updates).toHaveLength(2);
  });

  it('clears leftover invisible native groups before stacking', async () => {
    const { api, calls, store } = fakeApi([
      tab(1, 1, { groupId: 5, vivExtData: '{}' }),
      tab(2, 1, { groupId: 5, vivExtData: '{}' }),
    ]);
    const report = await applyStackPlans([{ name: 'News', tabIds: [1, 2] }], 1, api);
    expect(report.applied).toBe(1);
    expect(calls.ungrouped).toEqual([[1, 2]]);
    expect(store.get(1)?.groupId).toBeUndefined();
  });

  it('skips plans with fewer than two live tabs and drops dead ids first', async () => {
    const { api } = fakeApi([tab(1, 1), tab(2, 1)]);
    const report = await applyStackPlans(
      [
        { name: 'Dead ref', tabIds: [1, 99] },
        { name: 'Solo', tabIds: [2] },
      ],
      1,
      api,
    );
    expect(report).toMatchObject({ applied: 0, skipped: 2, failed: 0 });
  });

  it('isolates per-tab write failures to their own plan', async () => {
    const failing = fakeApi([tab(1, 1), tab(2, 1), tab(3, 1), tab(4, 1)]);
    // Fail only tab 2's updates by wrapping the fake's update.
    const inner = failing.api.update.bind(failing.api);
    failing.api.update = async (tabId, props) => {
      if (tabId === 2) throw new Error('boom');
      return inner(tabId, props);
    };
    const report = await applyStackPlans(
      [
        { name: 'A', tabIds: [1, 2] },
        { name: 'B', tabIds: [3, 4] },
      ],
      1,
      failing.api,
    );
    expect(report).toMatchObject({ applied: 1, failed: 1 });
    expect(report.failures.some((f) => f.includes('Stack "A"') && f.includes('tab 2') && f.includes('boom'))).toBe(true);
  });

  it('marks plans failed when a write is accepted but not persisted', async () => {
    const { api } = fakeApi([tab(1, 1), tab(2, 1)], { dropVivExtDataOnUpdate: true });
    const report = await applyStackPlans([{ name: 'News', tabIds: [1, 2] }], 1, api);
    expect(report.applied).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.failures.some((f) => f.includes('group not persisted'))).toBe(true);
  });

  it('returns an empty report for an empty plan list', async () => {
    const { api } = fakeApi();
    const report = await applyStackPlans([], 1, api);
    expect(report).toMatchObject({ applied: 0, skipped: 0, failed: 0, backend: 'stacks' });
  });
});

describe('unstackTabs', () => {
  it('removes exactly the stack fields and leaves other state', async () => {
    const { api, store } = fakeApi([tab(1, 1, { vivExtData: '{"group":"g","fixedGroupTitle":"N","workspaceId":9}' })]);
    await unstackTabs([1], api);
    expect(JSON.parse(String(store.get(1)?.vivExtData))).toEqual({ workspaceId: 9 });
  });
});
