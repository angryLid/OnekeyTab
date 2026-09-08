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

## Known limitations (demo-grade)

- The API key is stored **in plaintext** in `browser.storage.local`. Do not reuse a production
  key.
- OpenRouter's free models have low daily rate limits and vary in JSON reliability; invalid
  output is retried once and partial failures are skipped per group.
- Tabs are never merged into existing groups; each run creates new groups only.
- Firefox requires 139 or newer; Chrome requires 89 or newer.

## Test

```bash
pnpm test      # vitest, happy-path tests for the pure logic
pnpm compile   # type check
```
