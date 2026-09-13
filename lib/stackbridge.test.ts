import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE } from './constants';
import {
  BridgeError,
  createBridgePort,
  DEFAULT_UI_EXTENSION_ID,
  describeBridgeError,
  listStacks,
  createStack,
  probeBridge,
  resetBridgeProbeCache,
} from './stackbridge';
import type { BridgeApi, BridgeTabsApi } from './stackbridge';

const UI_ID = 'ui-extension-id';

function ok(id: string, result?: unknown) {
  return { v: BRIDGE.protocolVersion, id, type: 'response', ok: true, result };
}

function errResp(id: string, code: string, message: string) {
  return { v: BRIDGE.protocolVersion, id, type: 'response', ok: false, error: { code, message } };
}

interface Call {
  extId: string;
  message: Record<string, unknown>;
}

function fakeApi(handler: (message: Record<string, unknown>) => unknown): { api: BridgeApi; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    api: {
      async sendMessage(extId: string, message: unknown) {
        calls.push({ extId, message: message as Record<string, unknown> });
        return handler(message as Record<string, unknown>);
      },
    },
  };
}

function happyApi(overrides: { stacks?: unknown[]; layoutError?: { code: string; message: string } } = {}) {
  return fakeApi((message) => {
    const action = String(message.action);
    if (action === 'bridge.ping') return ok(String(message.id), { pong: true, protocol: BRIDGE.protocolVersion });
    if (action === 'bridge.capabilities') {
      return ok(String(message.id), {
        protocol: BRIDGE.protocolVersion,
        versions: [1, BRIDGE.protocolVersion],
        actions: ['bridge.ping', 'bridge.capabilities', 'stacks.list', 'stacks.create', 'layout.apply'],
      });
    }
    if (action === 'stacks.list') return ok(String(message.id), overrides.stacks ?? []);
    if (action === 'layout.apply') {
      if (overrides.layoutError) return errResp(String(message.id), overrides.layoutError.code, overrides.layoutError.message);
      const groups = (message.params as { groups: Array<{ name: string; tabIds: number[] }> }).groups;
      return ok(String(message.id), {
        rev: 1,
        applied: groups.map((g) => ({ name: g.name, groupExtId: `g-${g.name}`, tabIds: g.tabIds })),
        dissolved: [],
        skipped: [],
      });
    }
    if (action === 'stacks.create') return ok(String(message.id), { groupExtId: 'g-1' });
    return errResp(String(message.id), 'INTERNAL', `unexpected action ${action}`);
  });
}

beforeEach(() => {
  resetBridgeProbeCache();
  vi.restoreAllMocks();
});

describe('probeBridge', () => {
  it('sends a v1 request envelope and reports ok on a healthy bridge', async () => {
    const { api, calls } = happyApi();
    const result = await probeBridge(api, UI_ID);
    expect(result).toEqual({ ok: true });
    const [ping] = calls;
    expect(ping?.extId).toBe(UI_ID);
    expect(ping?.message).toMatchObject({ v: BRIDGE.protocolVersion, type: 'request', action: 'bridge.ping' });
    expect(typeof ping?.message.id).toBe('string');
  });

  it('memoizes per worker lifetime', async () => {
    const { api, calls } = happyApi();
    await probeBridge(api, UI_ID);
    await probeBridge(api, UI_ID);
    expect(calls.filter((c) => c.message.action === 'bridge.ping')).toHaveLength(1);
  });

  it('classifies an absent receiver as no-listener', async () => {
    const { api } = fakeApi(() => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const result = await probeBridge(api, UI_ID);
    expect(result).toMatchObject({ ok: false, reason: 'no-listener' });
  });

  it('classifies a hanging bridge as timeout', async () => {
    vi.useFakeTimers();
    try {
      const { api } = fakeApi(() => new Promise(() => {}));
      const pending = probeBridge(api, UI_ID);
      const expectation = expect(pending).resolves.toMatchObject({ ok: false, reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(BRIDGE.pingTimeoutMs + 10);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a NOT_PAIRED error as not-paired', async () => {
    const { api } = fakeApi((message) => errResp(String(message.id), 'NOT_PAIRED', 'Extension not paired.'));
    const result = await probeBridge(api, UI_ID);
    expect(result).toMatchObject({ ok: false, reason: 'not-paired' });
  });

  it('rejects a bridge speaking the wrong protocol', async () => {
    const { api } = fakeApi((message) => {
      if (message.action === 'bridge.capabilities') return ok(String(message.id), { protocol: 99, actions: [] });
      return ok(String(message.id));
    });
    const result = await probeBridge(api, UI_ID);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported', detail: expect.stringContaining('protocol 99') });
  });

  it('rejects a v1-only bridge (protocol 1 reported)', async () => {
    const { api } = fakeApi((message) => {
      if (message.action === 'bridge.capabilities') return ok(String(message.id), { protocol: 1, versions: [1], actions: ['bridge.ping', 'stacks.list', 'stacks.create', 'layout.apply'] });
      return ok(String(message.id));
    });
    const result = await probeBridge(api, UI_ID);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported', detail: expect.stringContaining('protocol 1') });
  });

  it('rejects a protocol-2 bridge lacking layout.apply', async () => {
    const { api } = fakeApi((message) => {
      if (message.action === 'bridge.capabilities') return ok(String(message.id), { protocol: BRIDGE.protocolVersion, versions: [1, 2], actions: ['bridge.ping', 'stacks.list'] });
      return ok(String(message.id));
    });
    const result = await probeBridge(api, UI_ID);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported', detail: expect.stringContaining('layout.apply') });
  });

  it('rejects a bridge lacking the required actions', async () => {
    const { api } = fakeApi((message) => {
      if (message.action === 'bridge.capabilities') {
        return ok(String(message.id), { protocol: BRIDGE.protocolVersion, actions: ['bridge.ping'] });
      }
      return ok(String(message.id));
    });
    const result = await probeBridge(api, UI_ID);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported', detail: expect.stringContaining('stacks.list') });
  });
});

describe('listStacks', () => {
  it('maps stacks to GroupInfo and drops junk entries', async () => {
    const { api } = happyApi({
      stacks: [
        { id: 's-1', name: 'Research', tabIds: [1, 2] },
        { id: '', name: 'no id', tabIds: [3] },
        { id: 's-2', name: 42, tabIds: [4, 'x', 5] },
        { id: 's-3', name: '', tabIds: [] },
        'garbage',
      ],
    });
    const groups = await listStacks(api, UI_ID);
    expect(groups).toEqual([
      { id: 's-1', name: 'Research', tabIds: [1, 2] },
      { id: 's-2', name: '', tabIds: [4, 5] },
    ]);
  });

  it('passes windowId when given', async () => {
    const { api, calls } = happyApi();
    await listStacks(api, UI_ID, 7);
    expect(calls[0]?.message.params).toEqual({ windowId: 7 });
  });
});

describe('createStack', () => {
  it('truncates the name to the protocol cap and returns the groupExtId', async () => {
    const { api, calls } = happyApi();
    const name = 'x'.repeat(80);
    const groupExtId = await createStack(api, UI_ID, [1, 2], name);
    expect(groupExtId).toBe('g-1');
    const params = calls[0]?.message.params as { tabIds: number[]; name: string };
    expect(params.name).toHaveLength(BRIDGE.nameMax);
    expect(params.tabIds).toEqual([1, 2]);
  });

  it('surfaces bridge error codes as BridgeError', async () => {
    const { api } = fakeApi((message) => {
      if (message.action === 'stacks.create') return errResp(String(message.id), 'BUSY', 'Another mutation is in flight');
      return ok(String(message.id));
    });
    const error = await createStack(api, UI_ID, [1, 2], 'n').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe('BUSY');
    expect(describeBridgeError(error)).toBe('BUSY: Another mutation is in flight');
  });
});

describe('applyLayout (via the port)', () => {
  function fakeTabs(initial: Array<{ id?: number; groupId?: number }> = []) {
    const store = initial.map((tab) => ({ ...tab }));
    const ungrouped: number[][] = [];
    const api: BridgeTabsApi = {
      async query() {
        return store.map((tab) => ({ ...tab }));
      },
      async ungroup(ids: number[]) {
        ungrouped.push([...ids]);
        for (const id of ids) {
          const tab = store.find((t) => t.id === id);
          if (tab) delete tab.groupId;
        }
      },
    };
    return { api, ungrouped };
  }

  it('exposes bridge caps: visible stacks, untrusted native groups, stacked label', async () => {
    const port = createBridgePort(happyApi().api, UI_ID, fakeTabs().api);
    expect(port.id).toBe('vivaldi-bridge');
    expect(port.caps).toEqual({
      visibleGroups: true,
      nativeGroupsTrustworthy: false,
      userGroupsReadable: true,
      visibleGroupReason: 'stacked',
    });
    expect(await port.probe()).toEqual({ ok: true });
  });

  it('falls back to an empty answer when stacks.list fails', async () => {
    const { api } = fakeApi((message) => errResp(String(message.id), 'UNSUPPORTED_API', 'gone'));
    const port = createBridgePort(api, UI_ID, fakeTabs().api);
    await expect(port.listGroups(1)).resolves.toEqual([]);
  });

  it('apply: one declarative layout.apply carries the whole plan; dead/small plans skipped client-side', async () => {
    const { api, calls } = happyApi();
    const { api: tabsApi, ungrouped } = fakeTabs([
      { id: 1, groupId: 9 },
      { id: 2 },
      { id: 3 },
      { id: 4 }, // plan B references 4 and 5; 5 is dead
    ]);
    const port = createBridgePort(api, UI_ID, tabsApi);
    const report = await port.apply(
      [
        { name: 'A', tabIds: [2, 3] },
        { name: 'B', tabIds: [4, 5] }, // 5 dead → one live tab → skipped
        { name: 'C', tabIds: [5] },
      ],
      1,
    );
    expect(report).toMatchObject({ applied: 1, skipped: 2, failed: 0, backend: 'stacks' });
    expect(ungrouped).toEqual([[1]]); // leftover native group cleared first
    const applies = calls.filter((c) => c.message.action === 'layout.apply');
    expect(applies).toHaveLength(1);
    expect(applies[0]?.message.v).toBe(BRIDGE.protocolVersion);
    expect((applies[0]?.message.params as { groups: unknown }).groups).toEqual([{ name: 'A', tabIds: [2, 3] }]);
  });

  it('apply: a bridge failure fails the whole transactional plan', async () => {
    const { api } = happyApi({ layoutError: { code: 'BUSY', message: 'Another mutation is in flight' } });
    const { api: tabsApi } = fakeTabs([{ id: 1 }, { id: 2 }]);
    const port = createBridgePort(api, UI_ID, tabsApi);
    const report = await port.apply([{ name: 'A', tabIds: [1, 2] }], 1);
    expect(report).toMatchObject({ applied: 0, failed: 1 });
    expect(report.failures[0]).toContain('layout.apply failed');
    expect(report.failures[0]).toContain('BUSY');
  });

  it('apply: no plans means no bridge traffic at all', async () => {
    const { api, calls } = happyApi();
    const { api: tabsApi } = fakeTabs();
    const port = createBridgePort(api, UI_ID, tabsApi);
    const report = await port.apply([], 1);
    expect(report.applied).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('apply: unchanged groups count as applied (idempotent re-send is a success, not a failure)', async () => {
    const { api, calls } = happyApi();
    // Override: every group comes back unchanged (already in the requested state).
    const api2: BridgeApi = {
      async sendMessage(extId, message) {
        const m = message as Record<string, unknown>;
        if (m.action === 'layout.apply') {
          const groups = (m.params as { groups: Array<{ name: string }> }).groups;
          return ok(String(m.id), { rev: 2, applied: groups.map((g) => ({ name: g.name, groupExtId: 'g', tabIds: [], unchanged: true })), dissolved: [], skipped: [] });
        }
        return happyApi().api.sendMessage(extId, message);
      },
    };
    const { api: tabsApi } = fakeTabs([{ id: 1 }, { id: 2 }]);
    const port = createBridgePort(api2, UI_ID, tabsApi);
    const report = await port.apply([{ name: 'A', tabIds: [1, 2] }], 1);
    expect(report).toMatchObject({ applied: 1, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('probe is memoized per cache lifetime (one ping across repeated probes)', async () => {
    const { api, calls } = happyApi();
    const port = createBridgePort(api, UI_ID, fakeTabs().api);
    await port.probe();
    await port.probe(); // memoized: still one ping
    expect(calls.filter((c) => c.message.action === 'bridge.ping')).toHaveLength(1);
  });
});

describe('DEFAULT_UI_EXTENSION_ID', () => {
  it('matches the verified Vivaldi UI extension id', () => {
    expect(DEFAULT_UI_EXTENSION_ID).toBe('mpognobbkildjkofajifpdfhcoklimli');
  });
});
