# Grouping ports: adapting to vendor browsers

Status: implemented (`lib/grouping-port.ts`, `lib/stackbridge.ts`). This document explains why
the vendor adaptation layer exists, how it is designed, and which trade-offs were accepted.
Companion documents: `docs/vivaldi.md` (the Vivaldi platform facts) and the upstream
StackBridge docs referenced there (frozen).

## The problem: grouping targets are browser-private

The pipeline above the write layer is browser-agnostic: dedupe, tab selection, the model call,
plan parsing, and logging never learn which browser they run in. The write layer is where
vendors diverge. Chromium's `chrome.tabs.group()` / `chrome.tabGroups.update()` always work at
the data layer, but Vivaldi replaces the tab strip UI and renders its own grouping model
(Tab Stacks) instead — native groups succeed invisibly there, and Vivaldi's stack APIs are
private to its UI page, unreachable from any extension context (`docs/vivaldi.md`).

The only sanctioned way to reach those private APIs from this extension is the **StackBridge
mod** — a Vivaldi UI modification, maintained in the author's Awesome-Vivaldi fork, that wraps
the private write path behind a versioned JSON-RPC surface callable over
`chrome.runtime.onMessageExternal`. Its protocol, security model, and caveats are documented in
that repository (`github.com/angryLid/Awesome-Vivaldi`, `Bridge/README.md` + `Bridge/API.md`) and
are treated as frozen from this side: this extension is a protocol client, never a fork.

So the extension faces a heterogeneous set of grouping targets — Chromium groups here, a
JSON-RPC bridge to Vivaldi's private stack model there, whatever a future vendor grows — and
the pipeline must not grow a branch per vendor. That is the port.

## The port

```ts
// Everything above this line never learns which browser it is running on.
export interface GroupingPort {
  readonly id: PortId;                        // 'native' | 'vivaldi-bridge'
  readonly caps: PortCaps;                    // declared semantics, not discovered per call
  probe(): Promise<PortProbeResult>;          // self-qualification, called only where availability is uncertain
  listGroups(windowId: number): Promise<GroupInfo[]>; // authoritative visible-group membership
  apply(plans: GroupPlan[], windowId: number): Promise<ApplyReport>; // whole-run commitment
}
```

Three rules give the interface its shape:

1. **Capabilities are declared, not sniffed.** A Vivaldi port says `nativeGroupsTrustworthy:
   false` once; selection and dedupe consume that flag instead of importing browser detection.
   The previous code leaked `treatNativeGroupedAsUngrouped: isVivaldi` through the whole
   pipeline — under the port, browser quirks are data owned by the implementation that has
   them. `visibleGroups` and `userGroupsReadable` are informational today (both current ports
   render and read groups) but keep the door open for a future port that writes state the user
   cannot see or read back.
2. **`listGroups` is the single source of truth for exclusion.** Stacked/grouped candidacy and
   dedupe eligibility derive from one authoritative membership query, never from re-parsing
   vendor metadata. Through the bridge this also covers stacks the *user* made by hand — the
   blind spot that motivated the old H10 experiment disappears because the bridge owns stack
   semantics.
3. **One port per run, chosen up front.** `apply` is a whole-run commitment. If the bridge
   fails mid-run, the affected plans fail with log entries; the pipeline never silently
   finishes the run through another transport. A window where one tab was written by the
   native path and its neighbor by the bridge is exactly the untested mixed state this codebase
   refuses to enter.

## Composition root

`selectPort(env, ports)` is the only place transport policy lives, and the policy is
browser-driven, not configurable (the old grouping-backend setting was removed — it never
changed the outcome in any branch):

| Browser | Bridge probe | Port |
| --- | --- | --- |
| Chrome / Chromium / Firefox / other non-Vivaldi | — (not probed) | **native** |
| Vivaldi | ok | **vivaldi-bridge** |
| Vivaldi | failed | **blocked** — run ends like a missing API key |

The blocked path mirrors the no-API-key path exactly: the run is recorded with an `error`
outcome and a reason, the badge stays clean, and the options page opens — where the StackBridge
status line carries the warning text. A probe that fails with an immediate "receiving end does
not exist" classifies as `no-listener` (mod absent or blocked at the manifest gate — the two are
indistinguishable from outside); a probe that hangs classifies as `timeout` (mod present but
silent). The warning text distinguishes the two so an installed-but-broken mod is not
misreported as missing.

## Why the vivExtData write path is gone

An earlier design wrote stack membership directly into each tab's `vivExtData` JSON via
`chrome.tabs.update` (the "Channel B" write path). It shipped as a phase-1 backend and was
removed in favor of bridge-first adaptation: the write path was undocumented and
version-sensitive, its visible result depended on an unverified read-back chain, and it could
not create *native* stacks — membership metadata without the C++-side group, so adjacency,
stack counters, and two-level bars were all unproven host experiments. The bridge produces real
native stacks through Vivaldi's own write path, reports membership authoritatively, and turns
every one of those experiments into either a solved problem or an upstream concern. The price
is a user-installed mod and an unauthenticated dev protocol — accepted explicitly, see
`docs/vivaldi.md` for the risk notes.

## Trade-offs accepted

- **Full port over partial port.** The native (Chromium/Firefox) path also lives behind the
  interface, so callers never branch on backend. The refactor touched the only
  host-verified-working path; parity is pinned by tests against the injected tab API, not by
  hope.
- **Pull-only.** No `events.subscribe`: the pipeline is click-driven, MV3 service workers die
  between clicks while the bridge loses its subscriber set on every UI reload, and event
  reception would add an `externally_connectable` manifest key for zero current consumers.
  The envelope already speaks v1; events remain a pure addition when a reactive feature exists.
- **Unauthenticated dev protocol.** The bridge's dev build accepts every sender; the client
  implements the `NOT_PAIRED` error flow now (surfaced on the options page with pairing
  instructions) so pairing lands later without client changes. Shipping against it is a
  documented trust decision: installing the mod is the user's act of trust.
- **Probe memoized per service-worker lifetime.** A missing mod fails fast (immediate
  transport error), so the negative cache costs almost nothing; a forced `stacks` setting
  bypasses the cache every run so a broken bridge stays diagnosable.
- **Uniform `listGroups` re-query.** The native port re-queries the window instead of reusing
  the tabs the pipeline already fetched. One cheap read per run buys interface uniformity and
  freshness; reads are never worth optimizing into divergence.
- **Frozen upstream.** The Bridge code is read-only from this side. Protocol drift is an
  upstream conversation, not a local patch.

## Host verification checklist

Transport facts that cannot be verified from source (each maps to a log line or the options
status line):

- **H11** — `bridge.ping` reaches window.html on a real install: `onMessageExternal` exists
  there, and Vivaldi's UI manifest lets an external extension deliver to it. Failure modes are
  exactly the probe's `no-listener` (either gate) and `timeout`.
- **H12** — `stacks.create` from the extension context produces a real, visible, correctly
  titled stack.
- **H13** — multi-window behavior: bridge v1 reads operate on the UI's *current* window, which
  may differ from the clicked window. Documented limitation; observe and log, never block.
- **H14** — leftover invisible Chromium groups: the bridge port clears them via
  `tabs.ungroup` before stacking (mixed state guard). Verify the ungroup is clean and the
  subsequent `stacks.create` does not resurrect ghosts.
- **H15** — `stacks.list` freshness immediately after `stacks.create` (pull-only means the
  next click's exclusion depends on read-your-writes).

## File map

| File | Role |
| --- | --- |
| `lib/grouping-port.ts` | `GroupingPort` interface, native port, `selectPort` composition root |
| `lib/stackbridge.ts` | StackBridge protocol client (envelope v1) + the `vivaldi-bridge` port |
| `lib/selection.ts` | consumes `caps` + `listGroups` output; no browser detection imports |
| `lib/vivaldi.ts` | runtime Vivaldi detection (still needed: bridge applicability, dedupe default, `vivaldi://` exclusion) |
| `entrypoints/background.ts` | detection → `selectPort` → blocked path or port-driven run |
| `entrypoints/options/` | StackBridge status line, install guide link, native option greyed on Vivaldi |
