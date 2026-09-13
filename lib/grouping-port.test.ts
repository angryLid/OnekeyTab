import { describe, expect, it, vi } from 'vitest';
import { nativePort, selectPort } from './grouping-port';
import type { GroupingPort, NativeTabGroupsApi, NativeTabsApi } from './grouping-port';
import type { ApplyReport, PortCaps, PortId, PortProbeResult } from './types';

function fakePort(id: PortId, probeResult: PortProbeResult = { ok: true }): GroupingPort {
  const caps: PortCaps = {
    visibleGroups: true,
    nativeGroupsTrustworthy: id !== 'vivaldi-bridge',
    userGroupsReadable: true,
    visibleGroupReason: id === 'vivaldi-bridge' ? 'stacked' : 'grouped',
  };
  return {
    id,
    caps,
    probe: vi.fn(async (): Promise<PortProbeResult> => probeResult),
    listGroups: vi.fn(async () => []),
    apply: vi.fn(async (): Promise<ApplyReport> => ({
      applied: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      backend: id === 'vivaldi-bridge' ? 'stacks' : 'native',
    })),
  };
}

describe('selectPort (composition root)', () => {
  it('non-Vivaldi: native, no probe traffic', async () => {
    const native = fakePort('native');
    const bridge = fakePort('vivaldi-bridge');
    const decision = await selectPort({ isVivaldi: false }, { native, bridge });
    expect(decision).toMatchObject({ kind: 'ready', backend: 'native' });
    if (decision.kind === 'ready') expect(decision.port).toBe(native);
    expect(bridge.probe).not.toHaveBeenCalled();
  });

  it('Vivaldi + healthy bridge: the bridge port wins with a recorded probe', async () => {
    const bridge = fakePort('vivaldi-bridge');
    const decision = await selectPort({ isVivaldi: true }, { native: fakePort('native'), bridge });
    expect(decision.kind).toBe('ready');
    if (decision.kind === 'ready') {
      expect(decision.port).toBe(bridge);
      expect(decision.backend).toBe('stacks');
      expect(decision.probe?.ok).toBe(true);
      expect(typeof decision.probe?.ts).toBe('number');
    }
    expect(bridge.probe).toHaveBeenCalledTimes(1);
  });

  it('Vivaldi + unreachable bridge: blocked with a reason naming the mod', async () => {
    const bridge = fakePort('vivaldi-bridge', { ok: false, reason: 'no-listener' });
    const decision = await selectPort({ isVivaldi: true }, { native: fakePort('native'), bridge });
    expect(decision.kind).toBe('blocked');
    if (decision.kind === 'blocked') {
      expect(decision.reason).toContain('StackBridge mod not detected');
      expect(decision.probe).toMatchObject({ ok: false, reason: 'no-listener' });
    }
  });
});

describe('nativePort', () => {
  function fakeNativeTabs(initial: Array<{ id?: number; groupId?: number }> = []) {
    const store = initial.map((tab) => ({ ...tab }));
    const groups: Array<{ tabIds: [number, ...number[]]; createProperties?: { windowId?: number } }> = [];
    const titles: Array<{ groupId: number; title?: string }> = [];
    const tabs: NativeTabsApi = {
      async query() {
        return store.map((tab) => ({ ...tab }));
      },
      async group(options) {
        groups.push(options);
        return 100 + groups.length;
      },
    };
    const tabGroups: NativeTabGroupsApi = {
      async update(groupId, properties) {
        titles.push({ groupId, title: properties.title });
        return {};
      },
    };
    return { tabs, tabGroups, groups, titles };
  }

  it('listGroups derives membership from groupIds and skips ungrouped tabs', async () => {
    const { tabs, tabGroups } = fakeNativeTabs([
      { id: 1, groupId: 7 },
      { id: 2, groupId: 7 },
      { id: 3 },
      { id: 4, groupId: 8 },
    ]);
    const port = nativePort(tabs, tabGroups);
    expect(await port.listGroups(1)).toEqual([
      { id: '7', name: '', tabIds: [1, 2] },
      { id: '8', name: '', tabIds: [4] },
    ]);
  });

  it('caps expose trustworthy native groups and the grouped label', () => {
    const { tabs, tabGroups } = fakeNativeTabs();
    const port = nativePort(tabs, tabGroups);
    expect(port.caps).toEqual({
      visibleGroups: true,
      nativeGroupsTrustworthy: true,
      userGroupsReadable: true,
      visibleGroupReason: 'grouped',
    });
  });

  it('apply: groups live ungrouped pairs and titles them', async () => {
    const { tabs, tabGroups, groups, titles } = fakeNativeTabs([{ id: 1 }, { id: 2 }, { id: 3, groupId: 5 }]);
    const port = nativePort(tabs, tabGroups);
    const report = await port.apply([{ name: 'Docs', tabIds: [1, 2] }], 3);
    expect(report).toMatchObject({ applied: 1, skipped: 0, failed: 0, backend: 'native' });
    expect(groups[0]?.tabIds).toEqual([1, 2]);
    expect(groups[0]?.createProperties).toEqual({ windowId: 3 });
    expect(titles).toEqual([{ groupId: 101, title: 'Docs' }]);
  });

  it('apply: plans under 2 live ungrouped tabs are skipped (also the Vivaldi 7.5 crash guard)', async () => {
    const { tabs, tabGroups, groups } = fakeNativeTabs([{ id: 1, groupId: 5 }, { id: 2 }]);
    const port = nativePort(tabs, tabGroups);
    const report = await port.apply(
      [
        { name: 'A', tabIds: [1, 2] }, // tab 1 is already grouped -> only 1 live candidate
        { name: 'B', tabIds: [2] }, // single tab
        { name: 'C', tabIds: [2, 99] }, // tab 99 is gone
      ],
      1,
    );
    expect(report).toMatchObject({ applied: 0, skipped: 3, failed: 0 });
    expect(groups).toHaveLength(0);
  });

  it('apply: per-plan failure isolation', async () => {
    const { tabs, tabGroups } = fakeNativeTabs([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    const failingTabs: NativeTabsApi = {
      ...tabs,
      async group(options) {
        if (options.tabIds.includes(1)) throw new Error('boom');
        return 200;
      },
    };
    const port = nativePort(failingTabs, tabGroups);
    const report = await port.apply(
      [
        { name: 'A', tabIds: [1, 2] },
        { name: 'B', tabIds: [3, 4] },
      ],
      1,
    );
    expect(report).toMatchObject({ applied: 1, failed: 1 });
    expect(report.failures[0]).toContain('Group "A"');
    expect(report.failures[0]).toContain('boom');
  });
});
