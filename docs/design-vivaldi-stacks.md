# Design: Vivaldi Tab Stacks backend (vivExtData write path)

Status: phase 1 implemented (`lib/vivaldi-stacks.ts` + wiring; `pnpm compile` / `pnpm test` on the
host are the static gates). The real gate is the host verification checklist H1–H9 below on a
actual Vivaldi 8.x install — until then the Reddit write path stays unproven, and every failure
mode degrades to the native-group behavior that shipped before this. Companion to
`docs/vivaldi-compatibility.md` (evidence and research history live there; this document
records the implementation decisions).

## What it is

A second grouping backend. On Vivaldi, instead of writing invisible native groups
(`chrome.tabs.group()` + `chrome.tabGroups.update()`), the extension writes Vivaldi's own
stack metadata into each tab's `vivExtData` JSON via `chrome.tabs.update`. The result is a
real, visible, titled Tab Stack in Vivaldi's tab strip — the thing native groups can never be
there. Everything else in the pipeline (selection, dedupe, model call, logs) stays put; only
the write layer and the eligibility rules that depend on "what is a grouped tab" change.

Evidence that the write path works: r/vivaldibrowser thread 1n5451s (extension-context
`chrome.tabs.update(id, { vivExtData })`), corroborated by production mods (TidyTabs converts
grouping results into stacks; TidyTitles writes `fixedGroupTitle`) and the Awesome-Vivaldi
field lists (`group`, `groupColor`, `fixedGroupTitle`, plus unrelated state that must be
preserved). Caveats from forum topic 113989: read semantics of `vivExtData.group` have varied
across builds, and mods run in the privileged UI context while we run in a normal extension
context — hence the capability probe below. The probe, not the doc, is the source of truth.

## Goals

- Visible grouping results on Vivaldi: named stacks in the tab strip, no side panel needed.
- Stack titles from the AI plan (`fixedGroupTitle = plan.name`), same as the native path's
  `tabGroups.update({ title })`.
- No regression on Chrome: the native path stays the default there; every Vivaldi-specific
  branch is gated on detection + probe.
- Graceful degradation: any probe or write failure falls back to the current native behavior.
- Diagnosability: probe outcome, backend used, and per-tab write verification land in the
  existing run log (the layer confusion that started all this must stay visible).

## Non-goals (deferred, with reasons)

- Stack colors (`groupColor`, `color1`–`color9`): the native path never sets colors today
  (title only); adding them is a cosmetic phase 2 once hue mapping is confirmed on a real
  install. No `groupColor` key is written in phase 1.
- Adjacency: TidyTabs pairs stack writes with `chrome.tabs.move` so members sit contiguously.
  Phase 1 ships scattered stacks and the host checklist decides whether scattered stacks
  render acceptably; only then is a `moveAdjacent` step added. Moving tabs reorders the
  user's strip — not something to do speculatively.
- Unstack / re-group UI: neither backend has an ungroup action today; symmetric gap, deferred.
- Workspaces, tiling, stack expand/collapse: no API surface at all; out of scope permanently.
- Chrome behavior changes: none. All new code paths are Vivaldi-gated.

## Core mechanism

`vivExtData` is a JSON string Vivaldi injects into `chrome.tabs.Tab` objects (legacy alias
`exData`, pre-5.3 `extData`). Stack membership is three optional keys inside it:

| Key | Type | Meaning |
| --- | --- | --- |
| `group` | string | Stack id; tabs sharing a value are one stack (write `crypto.randomUUID()`) |
| `fixedGroupTitle` | string | Stack title shown in the tab strip |
| `groupColor` | string | `color1`–`color9` or empty; **not written in phase 1** |

Write = read-modify-write per tab: parse the JSON, `Object.assign` the new keys (preserving
every unknown key — `workspaceId`, `fixedTitle`, tiling layout, follower ids, `ext_id`),
`JSON.stringify`, `chrome.tabs.update(tab.id, { vivExtData })`. Unstack = delete the three
keys. WXT's type definitions do not model `vivExtData`, so the update payload needs a cast
(same precedent as the `tabs.group` overload cast in `lib/apply-groups.ts`).

Idempotent by construction: re-running a plan over the same tabs overwrites the same keys;
a stale stack left behind when membership changes just empties (Vivaldi removes empty stacks —
to be confirmed on the host, see checklist item H6).

## Capability probe

The write path is undocumented and version-sensitive, so it is treated as a runtime
capability, never assumed. `probeStackSupport()` in `lib/vivaldi-stacks.ts`:

1. Preconditions: Vivaldi detected (`describeVivaldiSignals`). No field-presence precondition:
   the first probe design required the fresh tab to carry `vivExtData` and misjudged a real
   Vivaldi 8.x install as unsupported — a fresh `about:blank` tab may not have the field
   attached yet (or at all), which is exactly host experiment H7 below.
2. Active round-trip on the disposable tab: `tabs.create({ url: 'about:blank', active: false })`
   → read vivExtData (short retries absorb late attachment) → write stack keys with a
   throwaway group id → `tabs.get` and confirm the key stuck → delete the keys (rollback) →
   `tabs.remove`. On a plain Chromium build the unknown `tabs.update` property is either
   rejected (error reason) or silently dropped (write-rejected) — unsupported either way.
3. Outcome: `{ supported: true }` or `{ supported: false, reason }` with reasons
   `write-rejected` / `error: <message>`.

Caching: the result is memoized for the service worker's lifetime — one probe per SW wake,
not per click (MV3 restarts wipe it; a re-probe after an update is a feature, not a bug).
The probe fully completes before the run touches the window (create → remove before
`tabs.query`), so the temp tab never leaks into dedupe, selection, or the audit.

Why not probe on a user tab: a failed or half-applied write on real state is exactly the
class of bug this feature must not have; `about:blank` is free.

## Grouping backend

`Config.groupingBackend?: 'auto' | 'native' | 'stacks'` (absent = `auto`, same
merge-on-read pattern as `dedupe.ignoreGrouped`).

Effective backend per click:

| Setting | Chrome | Vivaldi, probe passed | Vivaldi, probe failed |
| --- | --- | --- | --- |
| `auto` (default) | native | **stacks** | native |
| `native` | native | native | native |
| `stacks` | native (with a logged warning) | stacks | native + probe error surfaced |

`stacks` forced on a probe failure re-probes on the next click (explicit override for
diagnosing after a Vivaldi update); `auto` keeps the negative cache for the SW lifetime.

## Module: `lib/vivaldi-stacks.ts`

Pure core (unit-testable, no browser import) + async appliers with an injected API object:

```ts
export type StackProbeReason = 'write-rejected' | 'error';
export interface StackProbeResult { supported: boolean; reason?: StackProbeReason; detail?: string }

export const STACK_FIELDS: readonly string[] = ['group', 'groupColor', 'fixedGroupTitle'];

/** Safe parse: string input only, malformed JSON and non-objects return null. */
export function parseVivExtData(raw: unknown): Record<string, unknown> | null;

/** Merge preserving unknown keys; pure. */
export function applyVivExtDataKeys(
  raw: string,
  update: { assign?: Record<string, unknown>; deleteKeys?: readonly string[] },
): string;

/** The stack test: a parsed vivExtData with a non-empty `group`. */
export function stackIdOf(tab: { vivExtData?: unknown }): string | null;

/** Probe + memoize; `api` injectable for tests. One probe per SW lifetime. */
export function probeStackSupport(api: StackApi): Promise<StackProbeResult>;

/** Apply plans as stacks; read-modify-write per tab, allSettled batching, verify by re-query. */
export function applyStackPlans(
  plans: GroupPlan[],
  windowId: number,
  api: StackApi,
): Promise<ApplyReport>;

/** Remove the three keys; exported for tests and future unstack UI. */
export function unstackTabs(tabIds: number[], api: StackApi): Promise<void>;
```

`StackApi` is the slice of `browser` used (`tabs.query/get/create/update/remove/ungroup`),
so tests pass fakes without a browser mock framework.

`applyStackPlans` mechanics, in order:

1. Fresh `tabs.query({ windowId })`; drop plan ids that are gone (native path's liveness rule).
2. **Clear leftover invisible native groups first**: `tabs.ungroup(tabIds)` for members still
   carrying `groupId > 0`. A tab in both an invisible native group and a visible stack is an
   untested state; one well-documented call removes the ambiguity.
3. Per plan: `group = crypto.randomUUID()`; per tab: read-modify-write
   `assign: { group, fixedGroupTitle: plan.name }`. Batch per plan with `Promise.allSettled`;
   per-tab errors land in `ApplyReport.failures` (`"Stack \"<name>\": tab <id>: <msg>"`).
4. Verify: re-query the window, confirm every written tab parses back with the expected
   `group`; mismatches are failures too (`"Stack \"<name>\": tab <id>: group not persisted"`).
   This is strategy item 5 from the compatibility doc — "write dropped" vs "UI stale" must be
   distinguishable in the log.
5. Report: `applied` counts plans fully written and verified; `skipped` plans under 2 live
   tabs (native path's rule); `failed` plans with any tab-level failure (partial stacks are
   reported, not silently kept).

## Pipeline integration (`entrypoints/background.ts`)

Per click, the sequence becomes:

1. `getConfig()`; hoist Vivaldi detection out of the dedupe block (today it only runs when
   dedupe is enabled) — dedupe, backend choice, and logging all need it.
2. Choose backend from the matrix above; probe if needed (`RunRecord.stackProbe` records the
   outcome with `ts` and `reason`). Detection + probe precede everything else because the
   backend decides the writer, and detection decides the eligibility rules.
3. Dedupe pre-pass: unchanged, except the eligibility chain is stack-aware (below).
4. Selection audit: Vivaldi-aware (below).
5. Model call: unchanged (30s per call; a timeout surfaces immediately as a run error — no silent wait).
6. Apply: `applyPlans(plans, windowId, backend, { treatGroupedAsUngrouped: isVivaldi })`
   dispatches to the native writer or `applyStackPlans`. `ApplyReport` gains a required
   `backend` field.
7. Run record: `backend` and `stackProbe` added; badge/log flow unchanged.

Event hygiene note for the future: `tabs.onUpdated` fires for `vivExtData`-only changes with
no `changeInfo.url`/`title`; any listener we add must ignore those, or we build a feedback
loop. No such listener exists today.

## Selection rules: what counts as "grouped"

The one semantic change with user-visible consequences, so it is spelled out:

- **GroupIds are untrusted on Vivaldi, everywhere** (the dedupe exception generalized):
  Vivaldi's `groupId` is invisible and possibly stale, so it never gates candidacy nor
  re-grouping. `auditSelection` takes `{ treatNativeGroupedAsUngrouped?: boolean }` and the
  native writer takes the equivalent `applyPlans` option, both set from Vivaldi detection —
  **not** from the backend choice. This also fixes the starvation problem: a Vivaldi window
  grouped by earlier runs used to shrink its candidate pool as invisible groups accumulated.
- New exclusion reason `'stacked'`: a tab whose `vivExtData.group` is set. Checked after
  `pinned` and before native `'grouped'` in `firstExclusionReason` — a tab with both a
  leftover native groupId and a live stack must classify as stacked, never as the
  Vivaldi-untrusted grouped case. Stacked tabs are excluded on every backend (mirrors
  Chrome: don't re-send already-grouped tabs). `AuditTab` gains `stackId?: string`.
- On Chrome, `treatNativeGroupedAsUngrouped` stays false: user-made groups are respected
  everywhere.

## Dedupe interplay

`dedupeEligibilityReason` keeps dropping only the native `'grouped'` rule under
`ignoreGrouped`. The new `'stacked'` reason is **not** droppable: a stack member is visible,
so closing its duplicate visibly shrinks a user-facing stack — the same policy as Chrome
groups, and the original Vivaldi exception (invisible groups only) is untouched. A tab that
is both natively grouped and stacked classifies as `stacked` (chain order above), so the
droppable rule can never close a visible stack member.

## Config, settings UI, logging

- `Config.groupingBackend?: GroupingBackend` in `lib/types.ts`; merged-on-read default
  `auto` in `lib/config.ts`.
- Options page: a "Vivaldi tab stacks" fieldset in the settings panel — select (Auto / Native
  groups / Vivaldi stacks) + muted explanation ("On Vivaldi, groups can be written as real
  Tab Stacks. Auto uses stacks when the browser confirms support."). Both existing save
  buttons already load-modify-save the whole config; they must carry the new field through
  (the dedupe save path previously rewrote `dedupe` only — check both).
- `types.ts`: `ExclusionReason += 'stacked'`; `AuditTab.stackId?`; `SelectionRecord.backend?`;
  `RunRecord.backend?` and `RunRecord.stackProbe?`; `ApplyReport.backend` (required).
- Options log detail: run records show `backend` (+ probe reason when unsupported);
  selection records show the stacked count. New record kind deliberately avoided — apply
  results are small and belong on the run record.

## Failure matrix

| Failure | Behavior |
| --- | --- |
| Probe: write not persisted (Chromium-like) | native fallback, `reason = 'write-rejected'` |
| Probe: write not persisted | native fallback, `reason = 'write-rejected'` |
| Probe: unexpected exception | native fallback, `reason = 'error'` + message |
| Apply: tab closed mid-run | tab dropped from plan like the native path |
| Apply: single tab write fails | plan marked failed, other plans continue |
| Apply: verification mismatch | plan marked failed; log shows which tabs failed read-back |
| Forced `stacks` on Chrome | native run + logged warning (no crash) |

## Test plan (vitest, same style as `lib/dedupe.test.ts`)

- `applyVivExtDataKeys`: assign, delete, both, unknown-key preservation, malformed JSON,
  non-object JSON (`'null'`, `'[]'`, `'3'`), empty-string input.
- `parseVivExtData` / `stackIdOf`: string vs object input (real Vivaldi injects strings;
  objects are defensive), missing/empty `group`, legacy alias fields ignored.
- `applyStackPlans` (fake `StackApi`): happy path writes expected JSON per tab; unknown keys
  preserved; liveness filter; <2 tabs skipped; native ungroup issued for `groupId > 0` tabs;
  per-tab failure isolation; verification pass and mismatch; report counts.
- `probeStackSupport`: supported path; each failure reason; memoization (probe called once).
- Selection: `'stacked'` fires before `'grouped'`; stacked excluded with
  `treatNativeGroupedAsUngrouped`; native-grouped included under the flag, excluded without;
  Chrome fixtures unchanged (no vivExtData → no stacked reason).
- Dedupe: `'stacked'` not droppable by `ignoreGrouped`; native `'grouped'` still droppable.
- Config: absent `groupingBackend` reads as `auto`; save paths preserve it.

## Host verification checklist (decisive experiments, Vivaldi 8.x real install)

Code review cannot settle these; each maps to a log line:

- H1: probe passes in extension context (the Reddit claim, on our hardware).
- H2: `crypto.randomUUID()` is accepted as a stack id by the UI (forum reports of Vivaldi's
  own `tab-<ulid>` format; if the UI ignores foreign ids, fall back to mimicking the format —
  experiment, not phase 1).
- H3: stack appears immediately, correctly titled, no reload.
- H4: scattered (non-contiguous) stack members render acceptably, else schedule the
  `moveAdjacent` phase 2.
- H5: restart persistence (expected: stacks survive — Vivaldi's own session format; the
  native-groupId path was the doubtful one).
- H6: emptying a stack (tab moved out/closed) removes it in the UI.
- H7 (observed on the first real run, Vivaldi 8.x): a freshly created `about:blank` tab does
  not carry `vivExtData` at creation time. RESOLVED by design change: the probe no longer
  requires the field's presence and judges purely by write→read-back; unknown is whether the
  write actually persists on this build (i.e. whether the next run flips the probe to ok).
- H8: old invisible native groups are cleanly absorbed (ungroup step leaves no ghosts).
- H9: `chrome.tabs.onUpdated` behavior on vivExtData writes (confirm no-listener status quo
  is safe; informs future event code).

## File-by-file change list

| File | Change |
| --- | --- |
| `lib/vivaldi-stacks.ts` | new — pure core, probe, applyStackPlans, unstackTabs |
| `lib/vivaldi-stacks.test.ts` | new — tests above |
| `lib/vivaldi.ts` | comment fix only if H-probe shows tab-level vivExtData alive on 8.x (doc currently claims removed in 6.7; mod evidence contradicts) |
| `lib/types.ts` | `GroupingBackend`, `ExclusionReason += 'stacked'`, `AuditTab.stackId?`, `SelectionRecord.backend?`, `RunRecord.backend?/stackProbe?`, `ApplyReport.backend` |
| `lib/config.ts` | merge-on-read default `auto` |
| `lib/selection.ts` | `'stacked'` rule + `auditSelection` options param |
| `lib/apply-groups.ts` | backend dispatch + `treatGroupedAsUngrouped` option; the cast to `StackApi` lives here |
| `lib/constants.ts` | `timeoutMs` 60s → 30s (model-call timeout surfaces immediately as a run error) |
| `entrypoints/background.ts` | hoist detection, backend matrix, probe call, pass backend through, log additions |
| `entrypoints/options/index.html` + `main.ts` | Vivaldi stacks fieldset; preserve field on both save paths; log detail lines |
| `docs/vivaldi-compatibility.md` | point "planned adaptation" at this document |

## Risks

- **Undocumented API**: Vivaldi can rename semantics any release; the probe converts breakage
  into a silent native fallback plus a logged reason, and the settings override lets users
  force either backend without a release.
- **Foreign stack id format** (H2): if the UI ignores UUIDs, phase 1 degrades to the current
  invisible-group behavior until the format is mimicked — no worse than today.
- **`fixedGroupTitle` pins the name**: user renames are overwritten on the next run —
  identical to the native path's `tabGroups.update({ title })`, so no regression, but worth a
  line in user-facing docs.
