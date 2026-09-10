# Design: Vivaldi Tab Stacks backend (vivExtData write path)

Status: phase 1 implemented (`lib/vivaldi-stacks.ts` + wiring; `pnpm compile` / `pnpm test` on the
host are the static gates). The real gate is the host verification checklist H1–H10 below on an
actual Vivaldi 8.x install — until then the Reddit write path stays unproven, and every failure
mode degrades to the native-group behavior that shipped before this. Companion to
`docs/vivaldi-compatibility.md` (our own logs and the original layer-confusion investigation live
there; this document records the implementation decisions and the reverse-engineering evidence
they rest on).

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

## How Vivaldi tab stacks actually work

Reverse-engineering notes from the Awesome-Vivaldi repo (`Others/Reverse/`, based on unpacking
Vivaldi 8.1.4087.40) settle the architecture. Vivaldi is three layers:

| Layer | Share | What lives there |
| --- | --- | --- |
| Chromium | ~92%, open source | TabStripModel, the extensions API — our entire world |
| C++ backend | ~3%, BSD (mirrored at `ric2b/Vivaldi-browser`) | Vivaldi's own tab model: stacks, workspaces, tiling |
| UI | ~5%, closed | Webpack app `gapp_browser_react` loaded by `window.html`: `background-common-bundle.js` (1.9 MB, JS↔C++ bridge) + `bundle.js` (6.5 MB, React tab strip) |

`vivaldi.*` is the JS bridge over the C++ backend, and it exists **only inside the UI page**.
This explains everything we observed in `docs/vivaldi-compatibility.md`:

- `chrome.tabs.group()` mutates the Chromium TabStripModel and succeeds — but Vivaldi's React
  tab strip renders its own stack model and never projects Chromium groups. Invisible by
  design, not a bug (forum topic 108502).
- The native path is worse than invisible on recent builds: Vivaldi 7.5 crashes 100% of the
  time on `chrome.tabs.group()` with a single tab (forum topic 110019). Our native writer's
  "skip plans under 2 tabs" rule is what keeps the fallback path off that mine.

There are exactly two channels that create *real* stacks:

**Channel A — `vivaldi.tabsPrivate.*` (privileged UI context, mods only).** The same channel
drag-and-drop uses. `tabsPrivate.move({ tabIds, target, tweaks })` creates/reparents stacks and
returns the native group id in `res.group`; `tabsPrivate.setGroupProperties({ groupExtId,
groupTitle | groupColor })` names and colors a stack; `tabsPrivate.unstack(groupId)` dissolves
one. The `tweaks` enum (`TabMotionTweaks` in LonMcGregor's VivaldiModdersAPI docs) carries the
motion semantics: `create-new-group`, `do-not-reparent`, `target-is-tab`, `group-follows-target`,
`preserve-group`, `untile`, `expand-related`, … Stacks made this way are indistinguishable from
hand-made ones (thumbnail mode, two-level bar, stack counter all work). **None of this is
reachable from an extension renderer** — it is the reason TidyTabs is a mod and not an
extension.

**Channel B — `vivExtData` via `chrome.tabs.update` (our channel).** Vivaldi injects a JSON
string field into every `chrome.tabs.Tab`, and the UI derives stack membership from it. Writing
it from a plain extension produces visible stacks (Reddit thread 1n5451s; Otto Tabs shipped
this as a store extension for years). Undocumented, version-sensitive — hence the probe.

Mods are loaded by copying `.js` files into `<app>/<version>/resources/vivaldi/` and adding
`<script>` tags to that directory's `window.html` (the official customization channel is
CSS-only: `vivaldi://flags/#vivaldi-css-mods` → Settings → Appearance → Custom UI
Modifications). Any Vivaldi upgrade replaces the version directory and wipes both — which is
why mod users run re-injection tools, and why our extension-side path is worth the trouble.

## Prior art: TidyTabs / TidyTitles

TidyTabs and TidyTitles (PaRr0tBoY/Awesome-Vivaldi modpack, `Vivaldi8.0Stable/Javascripts/`)
are the best-documented stack automation in the ecosystem — AI grouping mods whose grouping
target is exactly the artifact we want to produce. They are UI mods, not extensions, so they
use Channel A with Channel B as fallback. Reading their source (TidyTabs.js ~2400 lines, read
in full for this document) is the closest thing to a spec Vivaldi stacks have.

TidyTabs' `createTabStacks`, the authoritative native recipe, in order:

1. `chrome.tabs.move` every member adjacent to the plan's first tab, strictly sequential
   (`await` per move) — parallel moves corrupt indices because each move renumbers the strip.
2. Sleep ~100 ms for the React UI to settle the moves.
3. `vivaldi.tabsPrivate.move({ tabIds, target: tabIds[0], tweaks: ["do-not-reparent",
   "create-new-group", "target-is-tab"] })` → native group id.
4. `setGroupProperties({ groupExtId, groupTitle })`, then `setGroupProperties({ groupExtId,
   groupColor })` (sequential, one callback chain).
5. Per tab, read-modify-write `vivExtData` with `ext_id` (per-tab uuid), `parent_ext_id`
   (`null` for the stack leader, the leader's `ext_id` for members), `tidyStackOwner` /
   `tidyStackId` (ownership markers so the mod recognizes its own stacks later), plus
   `fixedGroupTitle` / `groupColor` — written via `chrome.tabs.update`, ~50 ms apart.

When `tabsPrivate.move` is unavailable or fails, TidyTabs falls back to **metadata-only
writes**: a fresh `crypto.randomUUID()` as `group` per plan, the same per-tab field writes, no
Channel A call at all — and its docs describe the stacks as rendering. That fallback is
precisely our write path, which yields three design-relevant facts:

- **Foreign stack ids are accepted**: Vivaldi's own ids are cuid-like (`cj8zbizrn000e425tomdaav3d`),
  and TidyTabs' fallback writes UUIDs; the DOM renders the stack header as `div.tab#tab-<groupExtId>`
  and mods fuzzy-match DOM `data-id`s by the id's first 8 characters, never by format. Strong
  prior for H2, still to be confirmed from our context.
- **Adjacency is part of the recipe in both paths**: TidyTabs moves members adjacent even when
  stacking via metadata alone. The ecosystem never ships scattered stacks, so H4 stays an open
  experiment rather than an assumed-ok.
- **Sequential-with-delays is their answer to UI races**, but they need it because they move
  tabs. Our phase 1 never calls `chrome.tabs.move`, so per-tab writes are index-independent and
  our `Promise.allSettled` batching is safe. If host verification shows dropped writes under a
  write burst (H3 verification covers this), switching `applyStackPlans` to sequential-with-delay
  is the one-step contingency.

TidyTitles is the naming/coloring half: AI-generated titles land in `setGroupProperties({
groupExtId, groupTitle })` *and* `vivExtData.fixedGroupTitle`, mirroring what our `fixedGroupTitle
= plan.name` write does — including the same caveat we inherit: it pins the name over user
renames.

Version archaeology of Channel B (the Otto Tabs lineage, forum topic 21669 onward) resolves the
contradiction noted in our own `lib/vivaldi.ts` comments: 2019, `tab.extData` with a `group` key
is discovered to drive stack membership, readable/writable from a store extension (Otto Tabs);
a later rename to `vivExtData` breaks it once (fixed in borsini/chrome-otto-tabs PR #11);
around 6.7 (2024) extension-context reports claim the field is "removed" (Otto Tabs drops its
Vivaldi path; a Vivaldi-only fork keeps working, topic 56025); yet the mods read and write
per-tab `vivExtData` continuously through 7.9/8.0/8.1 in the UI context. Conclusion: the 6.7
"removal" is extension-context folklore, not a data-layer fact — what *our* context sees is
exactly what the probe measures (H1/H7). One more read-side caveat lands on us from topic
113989: on some builds `chrome.tabs.query` returns an *empty* `group` for stacks the **user**
created in the UI — mods read in the UI context and never hit this; see the selection rules
below for what it means here.

## Core mechanism

`vivExtData` is a JSON string Vivaldi injects into `chrome.tabs.Tab` objects (legacy alias
`exData`, pre-5.3 `extData`). Mods defensively handle both string and object forms; real
Vivaldi injects strings, we parse defensively either way. Stack-relevant keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `group` | string | Stack id; tabs sharing a value are one stack (write `crypto.randomUUID()`) |
| `fixedGroupTitle` | string | Stack title shown in the tab strip |
| `groupColor` | string | `color1`–`color9` or empty; **not written in phase 1** |
| `ext_id` | string | Per-tab id used by Vivaldi's internal model (TidyTabs preserves/refreshes it) |
| `parent_ext_id` | string \| null | Stack leader's `ext_id` for members, `null` for the leader |

Phase 1 writes only the first three. TidyTabs' fallback path writes `ext_id`/`parent_ext_id`
too; our host checklist (H2 verification reads back the full object) will show whether the UI
cares. Everything else that appears in `vivExtData` — `workspaceId`, `fixedTitle` (per-tab
title override), tiling layout, follower ids, `panelId`, `thumbnail`, `urlForThumbnail` — is
state we must preserve.

Write = read-modify-write per tab: parse the JSON, `Object.assign` the new keys (preserving
every unknown key), `JSON.stringify`, `chrome.tabs.update(tab.id, { vivExtData })`. Unstack =
delete the stack keys. WXT's type definitions do not model `vivExtData`, so the update payload
needs a cast (same precedent as the `tabs.group` overload cast in `lib/apply-groups.ts`).

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
   rejected (error reason) or silently dropped (write-rejected) — unsupported either way. The
   write→read-back shape is the same one TidyTabs uses after its own writes (`getTab` +
   verify), so it is the ecosystem's validation pattern too.
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
   untested state; one well-documented call removes the ambiguity. This also keeps the
   fallback path permanently clear of the Vivaldi 7.5 single-tab `tabs.group` crash: a native
   group call never fires on the stacks backend at all.
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

No `chrome.tabs.move` in phase 1 (scattered stacks; H4 decides whether a `moveAdjacent` step
is added — and if it is, it must be sequential per TidyTabs' recipe, never batched).

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
- Known limitation, inherent to the read side: on some builds, stacks the **user** created in
  Vivaldi's UI read back with an empty `group` in extension context (forum topic 113989 — the
  mods never hit this because they read in the UI context). Such tabs classify as ungrouped
  candidates and can be re-stacked into a plan's stack. H10 measures whether our build
  exhibits this; nothing in phase 1 code can fix it, but the audit counts stacked tabs via
  the same read, so a systematic zero there is the diagnostic signature.

On Chrome, `treatNativeGroupedAsUngrouped` stays false: user-made groups are respected
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
| Probe: write not persisted (any browser) | native fallback, `reason = 'write-rejected'` |
| Probe: unexpected exception | native fallback, `reason = 'error'` + message |
| Apply: tab closed mid-run | tab dropped from plan like the native path |
| Apply: single tab write fails | plan marked failed, other plans continue |
| Apply: verification mismatch | plan marked failed; log shows which tabs failed read-back |
| Forced `stacks` on Chrome | native run + logged warning (no crash) |
| Fallback native run on Vivaldi 7.5+ | groups of ≥2 tabs only (the <2 skip rule is also the crash guard, topic 110019) |

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
- H2: `crypto.randomUUID()` is accepted as a stack id by the UI. Strong prior: TidyTabs'
  metadata-only fallback writes UUIDs and renders (the UI's own ids are cuid-like, format
  never validated as input) — but from our context it is still an experiment. If the UI
  ignores foreign ids, fall back to mimicking the cuid format.
- H3: stack appears immediately, correctly titled, no reload; write bursts of a full plan do
  not drop writes (if they do, sequential-with-delay writes are the contingency).
- H4: scattered (non-contiguous) stack members render acceptably. The ecosystem never ships
  scattered stacks (TidyTabs moves members adjacent in both of its paths), so treat "renders
  fine" as the claim to test, not the default; else schedule the `moveAdjacent` phase 2.
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
- H10: do **user-created** stacks read back a non-empty `group` in extension context on this
  build (topic 113989 says some builds return empty)? Decides whether the `'stacked'`
  exclusion is trustworthy for UI-made stacks or is best-effort for our own writes only.

## File-by-file change list

| File | Change |
| --- | --- |
| `lib/vivaldi-stacks.ts` | new — pure core, probe, applyStackPlans, unstackTabs |
| `lib/vivaldi-stacks.test.ts` | new — tests above |
| `lib/vivaldi.ts` | soften the "removed in 6.7" comments to "absent/unreliable in extension context on some builds" — the archaeology above shows the removal claim was extension-context folklore while mods kept using the per-tab field through 8.x; H1 decides what we actually see |
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
  force either backend without a release. The ecosystem's version history (rename at 5.x,
  breakage reports at 6.7) says breakage every few majors is the norm.
- **Context gap**: every production precedent except the Reddit thread runs in the privileged
  UI context, where `vivaldi.*` also exists as a stronger alternative; our extension context
  has exactly one data point (1n5451s) until H1 lands. The probe + native fallback cap the
  blast radius of a "no".
- **Foreign stack id format** (H2): if the UI ignores UUIDs, phase 1 degrades to the current
  invisible-group behavior until the format is mimicked — no worse than today.
- **`fixedGroupTitle` pins the name**: user renames are overwritten on the next run —
  identical to the native path's `tabGroups.update({ title })` and to TidyTitles' behavior,
  so no regression, but worth a line in user-facing docs.
- **Read-side blind spot** (H10): user-created stacks that read back empty are invisible to
  the `'stacked'` rule and may be re-stacked; cosmetic (tabs get re-homed), logged via the
  audit counts.

## References

- PaRr0tBoY/Awesome-Vivaldi — the modpack: `Vivaldi8.0Stable/Javascripts/TidyTabs.js` and
  `TidyTitles.js` (source of the Channel A recipe and the metadata-only fallback),
  `Doc/mod/TidyTabs.md`, `Others/Reverse/` (unpacked 8.1 bundles, `api-surface`),
  install guide `Vivaldi8.0Stable/README.md`; https://github.com/PaRr0tBoY/Awesome-Vivaldi
- LonMcGregor/VivaldiModdersAPI — community API reference for `vivaldi.tabsPrivate`
  (`move`, `setGroupProperties`, `unstack`, `TabMotionTweaks`);
  https://lonmcgregor.github.io/VivaldiModdersAPI/OfficialApi/tabsPrivate.html
- borsini/chrome-otto-tabs — the store-extension precedent for Channel B (PR #11: `extData`
  → `vivExtData` rename); https://github.com/borsini/chrome-otto-tabs
- Forum: topic 21669 (stack data in the `vivaldi` object — original `extData.group`
  discovery), 56025 (Otto Tabs Vivaldi-only fork), 108502 (native groups not rendered),
  110019 (7.5 single-tab `tabs.group` crash), 113989 (stack read semantics across builds);
  https://forum.vivaldi.net/t/<topic>
- r/vivaldibrowser 1n5451s — the extension-context write claim (details in
  `docs/vivaldi-compatibility.md`)
