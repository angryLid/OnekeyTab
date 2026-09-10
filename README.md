# AI Tab Grouper

A Chrome/Firefox extension (built with [WXT](https://wxt.dev)) that groups your open tabs with AI,
after an optional local dedupe pass closes near-duplicate tabs first.

Click the toolbar icon → the current window's ungrouped tabs are sent to an LLM → titled tab
groups are created. One button, two states: idle and pending.

## How it works

1. Click the toolbar icon.
2. **Dedupe pre-pass (default on, toggle in settings).** Eligible tabs (same rules as grouping:
   not pinned, not grouped, not browser-internal) in the current window are compared pairwise by
   a local URL-similarity score — no model involved. Tabs are sorted newest-first; each tab is
   compared against the current survivor anchor and closed when its score reaches the threshold
   (default 0.75). The newest tab of each near-duplicate family survives. Closed tabs are logged
   with full URLs so they can be recovered manually.
3. The extension collects grouping candidates in the **current window only**: tabs that are not
   already in a group, not pinned, and not browser-internal pages (`about:`, `chrome://`, etc.),
   sorted by most recently accessed, capped at 50.
4. Each candidate is sent to the model as `{ id, title (max 200 chars), url (origin + path,
   query parameters stripped) }`.
5. The model returns a JSON grouping plan; the extension validates it and creates new tab
   groups via `tabs.group()` + `tabGroups.update()` (title set, default color, not collapsed).

Provider: [OpenRouter](https://openrouter.ai) with the `openrouter/free` router (a free model
is picked automatically) and `provider.sort: "throughput"` (the fastest provider serving it).
Requests time out after 60 seconds. Invalid model output is retried once with the validation
errors appended.

## Dedupe scoring (local, no model)

URLs are reduced to a comparable identity: lowercase host (hard gate — different hosts never
match), path segments (empty segments dropped, non-empty fragment folded in as one trailing
segment), and query params as an order-insensitive map with tracking params (`utm_*`, `fbclid`,
`gclid`, …) stripped. Segment edit distance charges 1 per inserted/deleted segment and 2 per
substituted segment (a substituted segment means different content, not one page deeper):

```
similarity = 0.7 · (1 − pathDist / maxSegments) + 0.3 · (1 − queryDist / maxParams)
```

A score ≥ threshold (settings slider, default 0.75) closes the older tab. The calibration
lands in a deliberately narrow band: identical path with any differing query params scores
0.70 (kept — pagination, search ids, view switches, shared-link params), while one extra/missing
path segment scores 0.77 (closed — same page, tracking spam). Different Google Docs, wiki
articles, repos, and SPA hash views score ≤ 0.65 and survive.

**Vivaldi exception:** Vivaldi never renders native tab groups, so a `groupId` there is
invisible state. On Vivaldi the dedupe eligibility chain skips the `grouped` rule — grouped
tabs participate in dedupe and can be closed; `vivaldi://` pages are treated as internal. See
`docs/design-dedupe.md` and `docs/vivaldi-compatibility.md`.

## Button states

- **idle** — no badge. Click runs a grouping pass (or opens this settings page if no API key
  is configured).
- **pending** — gray `…` badge. The LLM request is in flight; clicks are ignored.
- **error** — red `✗` badge, kept until the next run starts. The message is shown on the
  settings page.
- **skip** — brief green `✓` when fewer than 3 candidate tabs exist (no LLM call is made).

## Setup

```bash
pnpm install
pnpm dev           # Chrome
pnpm dev:firefox   # Firefox 139+ required (tab groups API)
```

1. Click the extension icon — the settings page opens.
2. Enter an [OpenRouter API key](https://openrouter.ai/settings/keys) and click
   **Save & Verify** (a one-token test request validates it).
3. Optionally adjust the pre-group dedupe toggle and threshold slider in the settings page.

## Privacy

Tab titles and URLs (origin + path only — no query parameters) are sent to OpenRouter when you
trigger grouping. The dedupe pre-pass is purely local: nothing it computes is ever sent
anywhere. OpenRouter does not log prompts or completions by default. Nothing is sent until you
click the icon.

The developer **logs** (see below) are stored **locally in this browser's extension storage** —
they are never uploaded. They may contain the titles and URLs of the tabs you grouped (run log)
and of **all** tabs read while selecting candidates (selection log). **Dedupe logs additionally
store the full URL — including query and hash — of every tab the pre-pass compared or closed**, so
that a closed tab can be recovered manually from the log export. They never contain your API key.
Treat them as sensitive browsing data.

## Developer logs (developer-facing)

Three record kinds share one storage, one 5 MB cap, one log page, and one export:

### Run log (`kind: "run"`)

Every grouping run records what was sent to the model and what it returned, so you can inspect
"what exactly went over the wire" after the fact. Open the extension's settings page → **Logs**.

| Aspect | Behavior |
| --- | --- |
| Unit | One record per run, with one entry per LLM call (two when a retry happened) |
| Contents | Full request messages (system prompt + candidates), full raw model response, actual model id, per-call duration, parse errors. Skipped runs (fewer than 3 candidates) and no-key runs are recorded without a payload |
| Link | Each run record carries the id of the selection audit from the same click (`selectionId`); the run detail view has a button to show it inline |
| UI | Click a row to expand its calls |

### Tab selection log (`kind: "selection"`)

Answers "which tabs did the extension actually read, and why was each one kept or dropped?" —
written on every click, before anything can fail, so skipped and errored runs stay diagnosable.

| Aspect | Behavior |
| --- | --- |
| Unit | One record per click (per grouping pass) |
| Contents | Every tab `tabs.query({ windowId })` returned, in query order, each marked `selected` or excluded with the **first matching rule**: `no-id`, `pinned`, `grouped` (already in a tab group, with the group id), `no-url`, `internal-url` (`chrome://`, `about:`, extension pages, …), or `over-cap` (passed all rules but beyond the 50-candidate cap; the record includes `lastAccessed` since recency decides) |
| Privacy | Titles + origin/path only (query strings and hashes stripped); excluded tabs are logged too, so the log can be larger than the run log |
| UI | Filter bar: **All / Runs / Tab selection / Dedupe**. Click a selection row for the full tab table (✓ kept / ✗ dropped, reason, title, url) |

### Dedupe log (`kind: "dedupe"`)

Written by the pre-group dedupe pass, **before any tab is closed** — a crash mid-close stays
diagnosable. Outcomes (`removed` / `declined`) are backfilled after `tabs.remove()` resolves,
from a fresh window query.

| Aspect | Behavior |
| --- | --- |
| Unit | One record per click (per dedupe pass), whenever the toggle is on |
| Contents | Scoring params snapshot (threshold, weights, substitute cost), every eligible tab in comparison order with its role (`baseline` / `closed` / `ignored`), per-closed-tab score and baseline tab id, full URLs, planned vs actually closed counts |
| Privacy | Full URLs (query and hash included) are stored **locally only** so closed tabs can be recovered manually; never uploaded |
| UI | Click a dedupe row for the params line and the full comparison table (✓ survivor / ✗ closed with score, outcome, title, url); the run detail view links back to it and vice versa |

### Shared behavior

| Aspect | Behavior |
| --- | --- |
| Storage | Per-record key + lightweight index in `storage.local`; full payloads are read on demand |
| Cap | ~5 MB across both kinds (oldest records dropped first) — safely inside Chrome's default `storage.local` quota (~10 MB), no extra permission needed |
| UI | Recent 100 records shown; "Load earlier" paginates backwards |
| Export | "Export recent (100)" and per-record export, as pretty JSON downloads |
| Clear | "Clear all history" removes everything (labeled with the total record count) |

The toolbar badge / last-error state is user-facing and unchanged; the logs are a separate
developer tool.

## Known limitations (demo-grade)

## Known limitations (demo-grade)

- The API key is stored **in plaintext** in `browser.storage.local`. Do not reuse a production
  key.
- The dedupe pre-pass only runs when an API key is configured (a click without a key opens the
  settings page first).
- On Vivaldi, native tab groups are never rendered in the UI (data layer only); the dedupe
  pre-pass compensates by treating already-grouped tabs as eligible there. Grouping itself
  still writes invisible groupIds; see `docs/vivaldi-compatibility.md`.
- Browsers show a native beforeunload confirmation when closing a tab with unsaved input, and
  there is no API to skip it; a tab the user declines to close survives and is logged as
  `declined` (it then flows into grouping as usual).
- Bulk-closed tabs enter the browser's restore stack (Ctrl+Shift+T), which holds ~25 entries —
  dedupe logs are the durable record for larger batches.
- `tabs.Tab.lastAccessed` requires Chrome 121+ / Firefox 56+; tabs with it missing sort as
  oldest.
- OpenRouter's free models have low daily rate limits and vary in JSON reliability; invalid
  output is retried once and partial failures are skipped per group.
- Tabs are never merged into existing groups; each run creates new groups only.
- Firefox requires 139 or newer; Chrome requires 121 or newer (for `lastAccessed`).
- Firefox applies the same storage quota rules as IndexedDB; if the disk is full, a log write
  may fail (the code retries once after dropping the oldest record, then surfaces the error).

## Test

```bash
pnpm test      # vitest, happy-path tests for the pure logic
pnpm compile   # type check
```
