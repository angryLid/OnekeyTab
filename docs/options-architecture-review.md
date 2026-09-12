# Options page architecture review (2025 findings)

Scope: `entrypoints/options/` (main.ts 524 lines, index.html 133 lines, style.css 330 lines), cross-checked against `lib/config.ts`, `lib/logger.ts`, `lib/stackbridge.ts`, `lib/types.ts`.

Overall verdict: the page is not rotten, but it is getting shallower. The lib layer (config/logger/stackbridge) is healthy deep modules; the problems are concentrated in main.ts, which spreads three pieces of knowledge that should be hidden — config write strategy, record type discrimination, and panel routing — across the UI code.

## Severity overview

```
Severity  Issue                                              Blast radius
--------  -------------------------------------------------  -------------------------
P1  ██    1. Config read-modify-write triplicated            main.ts x3 + every future setting
P1  █     2. Record types discriminated by 'x' in obj        main.ts x2 + types.ts
P2  █     3. Two audit-table renderers duplicate ~30 lines   renderDedupe/SelectionDetail
P2  ▌     4. activateTab hardcodes 7 panel IDs               panel changes force route edits
P2  ▌     5. Log refresh logic duplicated + double count     refreshLogs/loadMore/filter
P3  ▎     6. refreshBridgeStatus: one function, four jobs    41 lines, reason→text mapping
P3  ▎     7. Inconsistent naming (4 status-element styles)   readability
P3  ▎     8. Single file with top-level side effects         testability
```

## Findings and minimal viable refactors

### P1-1 Config read-modify-write triplicated (deepest problem)

Three save buttons (`#save`, `#save-dedupe`, `#save-backend`, main.ts:100/126/153) each perform the same ritual:

```ts
const existing = await getConfig();
await setConfig({ provider: existing?.provider ?? 'openrouter', apiKey: existing?.apiKey ?? '', dedupe: ..., groupingBackend: ... });
```

Why this breaks the deep-module principle: `setConfig` is a shallow module — it requires every caller to rebuild the full Config, leaking the "don't clobber other fields" rule into all three UI handlers. Adding any new config field means editing all three sites; missing one silently loses data. The read-modify-write also has no atomicity, so rapid consecutive clicks have an overwrite window (low risk today, but the structural invitation is here).

Minimal refactor: add `updateConfig(patch: Partial<Omit<Config, 'provider'>>)` in `lib/config.ts` that does getConfig → merge → setConfig internally. Each handler then passes only its own slice. Net ~-20 lines in main.ts; new fields cost zero. No storage format change; keep `setConfig` for background use.

### P1-2 Record types discriminated by shape, no tag field

`toggleDetail` (main.ts:271) and `addLinkedRecordButton` (main.ts:323):

```ts
if ('plannedCloseCount' in record) ... else if ('tabs' in record) ...
// plus a triple-nested ternary of 'selectedCount' in linked checks
```

Why: `RunRecord/SelectionRecord/DedupeRecord` are a union discriminated only by field existence, forcing duck-typing in the UI. `LogIndexEntry` has a `kind` field but the full records do not — one concept, two discrimination schemes. Hidden coupling: renaming a field in types.ts silently breaks the `in` checks (TypeScript cannot catch it, because the `in` checks are themselves valid code).

Minimal refactor: add a discriminant `kind: 'run' | 'selection' | 'dedupe'` to the three record types (filled centrally in `recordLog`, or via const assertions in types.ts), and export three type guards. Replace both `in` chains in main.ts with guard calls. Changes confined to types.ts + logger.ts write sites + two spots in main.ts.

### P2-3 Two audit-table renderers duplicated

`renderDedupeDetail` and `renderSelectionDetail` (main.ts:369/424) each hand-build a `<table class="sel-table">`: same header structure, same ✓/✗ status column, same escaped title/url cells, same "Export this audit" button wiring. ~30 lines of structural duplication.

Minimal refactor: extract `renderAuditTable(detail, { headers, rows, exportLabel, record })`; the two functions reduce to "map row data + call". Do not merge them into one function (their column semantics differ) — only share the table skeleton and export-button logic.

### P2-4 activateTab hardcodes the panel list

main.ts:173-192 toggles `hidden` on 7 `#panel-*` sections one by one, with a special rule for the error panel (`isLogs ? true : errorSection.hidden`). Adding a settings section requires editing the routing function — HTML structure knowledge is copied into TS.

Minimal refactor: add `data-panel` attributes to sections in index.html (settings group / logs group); `activateTab` switches groups via `querySelectorAll('[data-panel]')`, keeping the error-panel exception as one documented line. HTML gains attributes; TS loses 6 hardcoded lines.

### P2-5 Log view refresh duplicated in three places + double query

`refreshLogs`, the `loadMore` handler, and the filter handler all repeat the tail `renderList(); await refreshCount(); loadMore.hidden = entries.length >= (await countRecords())`. Also `refreshLogs` calls `countRecords()` twice (once inside `refreshCount`, once for `loadMore.hidden`).

Minimal refactor: extract `renderLogsView()` (reusing a single `countRecords` result) and call it from all three sites. ~-15 lines and removes a double storage query per refresh.

### P3-6 refreshBridgeStatus: one function, four jobs (41 lines)

Detects Vivaldi → mutates the dropdown's option availability → probes the bridge → maps 5 probe.reason values to messages, all in one function. It also re-queries `#bridge-status` inside the function, inconsistent with the file's top-of-file centralized-query convention.

Minimal refactor: extract the reason→message mapping into a `Record<PortProbeReason, (ctx) => string>` table; split into `detectVivaldiAndCoerce()` + `describeProbe()`. Pure code motion, no behavior change.

### P3-7 Inconsistent naming

Four status elements, four styles: `status` (bare name, also shadows `window.status` semantics), `dedupeStatus`, `backendStatus`, and a local `statusLine` inside a function. `toggleDetail` claims to "toggle" but actually does "fetch record + dispatch render" asynchronously.

Minimal refactor: unify to an `xxxStatusEl` suffix; rename `toggleDetail` to `expandDetail` (loads on expand). Pure rename, one commit.

### P3-8 Single file with top-level side effects

main.ts interleaves DOM queries, event registration, and the `void initSettings()` boot call at top level; nothing is unit-testable in isolation.

Minimal refactor (deferrable): split into `settings.ts` / `logs.ts` / `tabs.ts` modules each exporting `init()`, with main.ts as assembly only. The only item that moves files; decide after P1/P2 land.

## Suggested execution order

1. Batch 1 (P1, best value/risk ratio): items 1 → 2, each its own commit, then run vitest + a host-side build.
2. Batch 2 (P2, pure consolidation): items 3 → 5 → 4, no behavior change.
3. Batch 3 (P3, optional): 6 and 7 opportunistically; 8 is a separate decision.

Status: report only — no code changed. Revisit this file when refactoring is scheduled.
