# AI Tab Grouper

A Chrome/Firefox extension (built with [WXT](https://wxt.dev)) that groups your open tabs with AI.

Click the toolbar icon → the current window's ungrouped tabs are sent to an LLM → titled tab
groups are created. One button, two states: idle and pending.

## How it works

1. Click the toolbar icon.
2. The extension collects candidates in the **current window only**: tabs that are not already
   in a group, not pinned, and not browser-internal pages (`about:`, `chrome://`, etc.), sorted
   by most recently accessed, capped at 50.
3. Each candidate is sent to the model as `{ id, title (max 200 chars), url (origin + path,
   query parameters stripped) }`.
4. The model returns a JSON grouping plan; the extension validates it and creates new tab
   groups via `tabs.group()` + `tabGroups.update()` (title set, default color, not collapsed).

Provider: [OpenRouter](https://openrouter.ai) with the `openrouter/free` router (a free model
is picked automatically) and `provider.sort: "throughput"` (the fastest provider serving it).
Requests time out after 60 seconds. Invalid model output is retried once with the validation
errors appended.

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

## Privacy

Tab titles and URLs (origin + path only — no query parameters) are sent to OpenRouter when you
trigger grouping. OpenRouter does not log prompts or completions by default. Nothing is sent
until you click the icon.

The developer **logs** (see below) are stored **locally in this browser's extension storage** —
they are never uploaded. They may contain the titles and URLs of the tabs you grouped (run log)
and of **all** tabs read while selecting candidates, including excluded ones (selection log), so
treat them as sensitive browsing data. They never contain your API key.

## Developer logs (developer-facing)

Two record kinds share one storage, one 5 MB cap, one log page, and one export:

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
| UI | Filter bar: **All / Runs / Tab selection**. Click a selection row for the full tab table (✓ kept / ✗ dropped, reason, title, url) |

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

- The API key is stored **in plaintext** in `browser.storage.local`. Do not reuse a production
  key.
- OpenRouter's free models have low daily rate limits and vary in JSON reliability; invalid
  output is retried once and partial failures are skipped per group.
- Tabs are never merged into existing groups; each run creates new groups only.
- Firefox requires 139 or newer; Chrome requires 89 or newer.
- Firefox applies the same storage quota rules as IndexedDB; if the disk is full, a log write
  may fail (the code retries once after dropping the oldest record, then surfaces the error).

## Test

```bash
pnpm test      # vitest, happy-path tests for the pure logic
pnpm compile   # type check
```
