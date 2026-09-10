# Vivaldi Compatibility Research

Research notes on running this extension (AI Tab Grouper) in Vivaldi 8.x
(Chromium-based). Written after observing a discrepancy between extension
logs and the actual browser UI: logs showed many tabs carrying a `groupId`,
but the tab strip displayed no groups at all.

## TL;DR

- The extension works in Vivaldi at the API/data level; nothing crashes or
  silently fails.
- Vivaldi replaces Chromium's native tab strip with its own UI and does not
  render native tab group visuals (colored capsules, collapse headers).
- Vivaldi's own replacement feature, Tab Stacks, has no public extension
  API, so an extension cannot create or control stacks.
- Best achievable adaptation: full data-layer support (100%), zero native
  visual support (0%). Workaround is to show grouping results in the
  extension's own UI (side panel), optionally paired with a user-installed
  Vivaldi UI mod that mirrors native groups into Tab Stacks.

## Architecture: why the API works but the UI shows nothing

Chromium separates tab management into layers:

```
+---------------------------------------------+
|  UI layer (draws group capsules, headers)   | <- Vivaldi replaces this;
|                                             |    does not draw groups
+---------------------------------------------+
|  TabStripModel (data model)                 | <- groupId really lives
|                                             |    here; read/write works
+---------------------------------------------+
|  Extensions API (chrome.tabs/tabGroups)     | <- operates purely on the
|                                             |    data model
+---------------------------------------------+
```

`chrome.tabs.group()` / `chrome.tabGroups.*` operate on the TabStripModel.
In Vivaldi these calls succeed, the groupId persists, and group semantics
(move/close behavior) follow Chromium rules. What is missing is only the
projection of that model into visuals, because Vivaldi draws its own tab
bar to support Tab Stacks, Two-Level Tab Bars, and Tab Tiling.

This is not a wild-pointer situation: reads and writes are consistent and
reliable. The closest analogy is headless Chrome or a backend API whose
data never gets a frontend page.

Vivaldi is technically compliant: the extension API contract promises data
model changes, never a specific UI. Known community threads on this:

- https://forum.vivaldi.net/topic/108502/vivaldi-does-not-recognize-chrome-tabgroups
- https://forum.vivaldi.net/topic/81398/can-we-have-normal-tab-groups-like-the-other-chromium-browsers-such-as-brave-chrome

## Evidence from our own logs

- Selection snapshot (ts 1788957243849) captured the pre-grouping state;
  the model response (run ts 1788957243835, response at ...3855) then
  produced valid groups ("邮箱", "编程研究") using only real tab ids.
- Even a `vivaldi://policy/` tab received a groupId, proving
  `chrome.tabs.group()` works for any tab — the divergence is purely in
  the rendering layer, not the API layer.
- Caveat: persistence across restart is a separate risk. Vivaldi saves
  sessions in its own format; whether native groupIds survive a restart
  has been reported as unreliable on the forums. Untested by us.

## Tab Stacks: no API, dead end for extensions

Tab Stacks (and Workspaces) are not exposed to extensions at all. Feature
requests exist but nothing has shipped:

- https://forum.vivaldi.net/topic/113989/api-for-activating-expanding-tab-groups-programmatically

So an extension cannot create, name, collapse, or expand a stack. This is
a hard wall as of Vivaldi 8.x.

## Escape hatch: Vivaldi UI Modifications (user-side mod)

Vivaldi tolerates UI modding:

1. User enables `vivaldi://experiments` -> "Allow UI Modifications".
2. User drops a `.js`/`.css` file into the profile's `User Files`
   directory and restarts.
3. The mod runs inside the browser UI process, where it can access BOTH
   `chrome.tabs.*` / `chrome.tabGroups.*` (the same data model the
   extension writes to) AND Vivaldi's internal tab bar components,
   including stack operations (undocumented, reverse-engineered by the
   mod community; may break on major Vivaldi updates).

Key design insight: the extension and the mod need no private channel —
the native groupId itself is the interface. The extension writes groups
via the standard API; the mod watches for groupId changes and mirrors
them as Tab Stacks. Existing community mods (auto-stack / TidyTabs-style)
may already do this:

- https://github.com/PaRr0tBoY/Awesome-Vivaldi (mod docs, e.g. TidyTabs)

Limitations to document for users: manual install, no store distribution,
no compatibility guarantee across Vivaldi versions, and the mod's
reliability becomes the perceived reliability of our grouping feature.

## Recommended adaptation strategy

1. Detect Vivaldi at runtime (e.g. `navigator.userAgentData.brands`
   containing "Vivaldi").
2. On Vivaldi, keep grouping functional but stop expecting visuals:
   render the grouping result in the extension's own UI (side panel with
   clickable per-group tab lists) so users see what the AI decided.
3. Optionally skip `chrome.tabs.group()` on Vivaldi if the invisible
   grouping causes confusion; decide based on whether group semantics
   (persistence, ordering) still add value for the user.
4. In the options page / docs, tell Vivaldi users about the UI
   Modifications route for real tab-strip stacks.
5. Add post-grouping verification logging (re-query
   `chrome.tabs.query` and record final groupIds) to distinguish
   "model returned nothing" / "group call failed" / "call succeeded but
   UI does not show it" — this confusion is exactly what triggered this
   investigation.

## Summary table

| Layer | Status in Vivaldi 8.x |
|---|---|
| `chrome.tabs.group()` and data model | Works, reliable |
| Native tab group UI rendering | Not rendered (by design) |
| Tab Stacks extension API | Does not exist |
| UI Modifications mod bridge | Possible, user-installed, unofficial |
| Native group persistence across restart | Unverified, forum reports of loss |

## Implemented adaptation: dedupe exception (this codebase)

The dedupe pre-pass (see `docs/design-dedupe.md`) now adapts to Vivaldi:

- `lib/vivaldi.ts` detects Vivaldi at runtime with five signals, in priority order:
  1. **Window-object field** — since ~Vivaldi 6.7 (2024-05) Vivaldi removed the tab-level field
     and now injects `vivExtData` (legacy `extData`) into each `chrome.windows.Window` object
     instead (SO 68659729 comment by woxxom; Violentmonkey's `src/background/utils/ua.js`
     `checkVivaldi(wnd)` uses exactly this and is the production-grade precedent).
  2. **Tab-object fields** — `vivExtData` (current, a JSON string), `exData`, and the pre-5.3
     `extData` alias, which Vivaldi injected into every `chrome.tabs.Tab` before 6.7
     (SO 68659729, chrome-otto-tabs PR #11). Kept for older builds; no longer fires on 6.7+.
  3. **Vivaldi-specific tab URLs** — the `vivaldi://` scheme, the fake `chrome://vivaldi-webui/`
     URL the web UI reports for the start page / new tab (forum topic 87056,
     w3c/webextensions#470; Opera's equivalent is `chrome://startpageshared/`), and the internal
     UI extension origins `chrome-extension://mpognobbkildjkofajifpdfhcoklimli/` (current) and
     `chrome-extension://mpognobbkildjkoffnifgbdaajjmofk/` (pre-5.x builds).
  4. **UA-CH brands** and 5. **UA string** — only match when the user opted in to branding
     (Vivaldi masks both by default, see the official help page linked above).
  Signals 1–3 survive brand masking. Detection is browser-wide (all windows queried), since
  Vivaldi-ness is a browser property and the per-window signals may live elsewhere.
  `describeVivaldiSignals` returns which probes fired; the background log prints them
  (`Vivaldi detected via: …`) so a missed detection is diagnosable from the log.
- On Vivaldi only, the dedupe eligibility chain (`lib/selection.ts` →
  `dedupeEligibilityReason`) drops the `grouped` rule: tabs carrying an invisible groupId
  participate in dedupe and can be closed. Closing a grouped tab just shrinks an unrendered
  group; empty groups vanish in the data model, so there is no UI-level damage.
- `vivaldi://` was added to the internal-scheme exclusion list (it was previously treated as a
  normal page and could be grouped/deduped).
- Each dedupe record snapshots `params.ignoreGrouped`, and the log detail view shows
  "grouped tabs in scope (Vivaldi)" — the layer confusion that triggered the original
  investigation is now visible in the logs, as recommended in strategy item 5 above. A settings
  override (Auto / Always include / Never include) covers a fully-masked Vivaldi where neither
  signal fires.
- Grouping candidate selection is unchanged on Vivaldi (already-grouped tabs are not re-sent to
  the model); invisible groups keep accumulating until a native-UI bridge (UI Modifications mod,
  side panel, strategy items 2/4) is built.
