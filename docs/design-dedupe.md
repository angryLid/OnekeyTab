# Design: Pre-group dedupe (URL-similarity tab closing)

Status: implemented. This document records the design decisions settled during the design
review, so future changes know which knobs are load-bearing.

## What it is

A local, model-free pre-pass that runs before every AI grouping click. It compares the URLs of
the current window's eligible tabs, closes each tab that closely matches a newer tab, and lets
the newest tab of each near-duplicate family survive into grouping.

- Trigger: the existing toolbar click, as a pipeline pre-pass.
- Toggle: settings page, default **on**.
- Threshold: settings slider, 0.50–0.95 step 0.05, default **0.75**.
- Scope: current window only; eligibility = the grouping selection rules (not pinned, not
  grouped, not browser-internal, has id and URL) **without** the 50-tab cap (the cap applies
  later, to what is sent to the model).

## Scoring model

Deliberately not raw character-prefix similarity — that metric is dominated by `https://` +
hostname and cannot separate "same article, tracking-param spam" (the motivating case) from
"different wiki article" (must keep). Instead, component scoring:

Normalization (`normalizeUrl`):

- host lowercased, **hard gate**: different hosts score 0; scheme and ports ignored entirely.
- path split into segments; empty segments dropped (trailing slash handled for free).
- a non-empty fragment is folded in as **one** trailing segment (`#/settings` → `settings`), so
  SPA hash views of the same app are treated as different content and survive.
- query params parsed into an order-insensitive key→value map; tracking params (`utm_*`,
  `fbclid`, `gclid`, `msclkid`, `dclid`, `spm`, `scm`, `igshid`, `si`, `share_source`) stripped
  first.

Distance (`segmentDistance`, `queryDistance`):

- path: weighted segment edit distance — insert/delete cost **1**, substitute cost **2**. The
  substitution penalty is the load-bearing choice: it scores "different content at the same
  position" (different Google Doc, different wiki article) strictly worse than "one page
  deeper" (the motivating `A/B/C` vs `A/B/` case), making the two separable by threshold. With
  unit substitution cost, any threshold that closes the motivating case also closes different
  Google Docs.
- query: keys only in A + keys only in B + shared keys with differing values.
- `sim = 1 − dist / max(lenA, lenB)` per component; both-empty counts as 1.

Blend: `score = 0.7 · simPath + 0.3 · simQuery` (constants in `DEDUPE`, not user-facing).

Calibration (the blessed verdict table, encoded as fixtures in `lib/dedupe.test.ts`):

| Case | Score | Verdict at 0.75 |
| --- | --- | --- |
| same URL ± tracking param / trailing slash / param order | 1.0 | close |
| exact duplicate (incl. Gmail `#inbox`) | 1.0 | close |
| `http` vs `https` same path | 1.0 | close |
| same path, params differ (pagination, search ids, view switches, extra shared-link params) | 0.70 | keep |
| `A/B/C` vs `A/B/` (one segment deeper) | 0.77 | close |
| pagination `?page=2` vs `?page=7` | 0.70 | keep |
| HN `item?id=111` vs `?id=222` | 0.70 | keep |
| `?tab=grid` vs `?tab=list` | 0.70 | keep |
| two different Google Docs | 0.65 | keep |
| wiki Cat vs Dog / different repos / SPA hash views / homepage vs subpage | ≤ 0.3 | keep |
| different hosts | 0 (hard gate) | keep |

The whole design's discrimination lives in the 0.70 (keep) → 0.77 (close) band; the threshold
slider is coarse by nature, and 0.75 splits the band.

## Clustering: baseline scan (`planDedupe`)

Not transitive closure — a baseline-scan rule, O(n²) worst case: sort eligible tabs by
`lastAccessed` descending (id ascending as tie-break); each surviving tab becomes a baseline
and is compared against every unmarked, parseable tab below it; matches at score ≥ threshold
are marked closed and skipped afterwards; the next unmarked tab becomes the next baseline.
Every duplicate family collapses to its newest member no matter how many unrelated tabs sit
between them — the first shipped variant compared each tab against the current anchor only
and missed exactly those cases (identical tabs separated by unrelated pages survived; fixed
from a real-run log). Deterministic and replayable. The log records decisions (one entry per
tab, grouped under its closing baseline with the comparison score), not every pairwise
comparison — O(n²) comparison records would burn the 5 MB log cap.

## Pipeline order (per click)

1. `tabs.query({ windowId })`.
2. Dedupe pre-pass (if enabled): filter eligible → `planDedupe` → **persist the dedupe record
   before closing anything** (crash mid-close stays diagnosable) → `tabs.remove(closedIds)` in
   one call → re-query the window → backfill per-tab `outcome` (`removed` / `declined`) and
   `closedCount`.
3. Existing selection audit runs on the (possibly reduced) tab list; the 50 cap and the
   `< 3 candidates` skip logic apply here. Dedupe still logs even when grouping then skips.
4. LLM → groups as before. The run record links `dedupeId`; the dedupe record links `runId`.

Failure handling: `tabs.remove` errors are non-fatal (tabs may have been closed manually
mid-run — truth comes from the re-query, not the API result). A declined native beforeunload
prompt ("Leave site?") leaves the tab open; it is logged `declined` and flows into grouping.
The browser-native beforeunload dialog is the only form-data protection, by design (alpha:
no whitelist, no per-site rules, no undo UI — the log plus Ctrl+Shift+T is the recovery path).

## Logging

Third record kind `dedupe`, sharing the existing index/5 MB cap/filter bar/export. Stores full
URLs (query and hash included) — a deliberate, documented extension of the log privacy stance,
local-only, required for manual recovery because the browser restore stack holds only ~25
entries. Badge flashes `-N` (actual closed count) on success/skip when N > 0; red error badge
wins over it.

## Config

`Config.dedupe: { enabled, threshold }`, merged with defaults on read so pre-existing stored
configs behave as enabled/0.75. UI surface: toggle + threshold slider only; weights, costs and
the tracking list are structural constants in `lib/constants.ts`.

## Version floor

`tabs.Tab.lastAccessed` requires Chrome 121+ / Firefox 56+; there is no creation-time API. The
Chrome floor is raised to 121; tabs missing the field sort as oldest.

## Vivaldi exception

Vivaldi (Chromium-based) replaces the native tab strip and does not render native tab groups:
`groupId` exists in the data layer but is invisible in the UI (platform facts in
`docs/vivaldi.md`, port design in `docs/grouping-port.md`). Without an exception, a Vivaldi window where every tab has
been grouped by earlier runs would show `eligible 4 · read 68` in the logs — the extension and
the user would disagree about which tabs are "in use".

**Detection.** Vivaldi masks its branding by default in both the UA string and the UA-CH brand
list (confirmed by help.vivaldi.com: "Vivaldi does not use a browser-identifiable User-Agent or
Client-Hints by default"), so UA-based detection is unreliable by design. The detection ladder:

1. `isVivaldi(tabs)` — Vivaldi injects a `vivExtData` property (legacy `exData`) into every
   `chrome.tabs.Tab` object handed to extensions; its presence on any queried tab is the
   masking-proof signal (forum-verified by third-party extension authors).
2. `isVivaldiFromNav()` — UA-CH brand list and UA string, checked together (no short-circuit);
   only matches when the user opted in to branding via User Agent Brand Masking.
3. Manual override — the dedupe settings expose three states for "tabs already in groups":
   Auto (default, runtime detection), Always include, Never include.

Detection switches the dedupe eligibility chain to `dedupeEligibilityReason(t, ignoreGrouped)`,
which drops the `grouped` rule — grouped
tabs participate in dedupe and can be closed (they simply leave their unrendered group; empty
groups disappear in the data model). Other rules (pinned, internal pages — including
`vivaldi://`, now in the internal-scheme list) still apply. The applied scope is snapshotted in
each dedupe record (`params.ignoreGrouped`) and shown in the log detail. Grouping candidate
selection is deliberately unchanged: migrating already-grouped tabs into fresh invisible groups
would be churn without UI payoff.
