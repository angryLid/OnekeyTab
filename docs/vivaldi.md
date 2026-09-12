# Vivaldi support

Condensed from two retired research documents (`vivaldi-compatibility.md`,
`vivaldi-stacks.md`); the durable facts survive here, the deep reverse-engineering lives
upstream. Written for maintainers of this extension; for the Bridge itself, read the frozen
docs referenced below.

## Why native tab groups are invisible in Vivaldi

Vivaldi is roughly three layers: Chromium (~92%, including the extensions API and the
TabStripModel this extension writes through), a small C++ backend carrying Vivaldi's own tab
model (stacks, workspaces, tiling), and a closed webpack UI app loaded by `window.html` that
replaces the tab strip. `chrome.tabs.group()` succeeds because it operates on the Chromium data
layer — but Vivaldi's React tab strip renders the C++ stack model and never projects Chromium
groups. Invisible by design, not a bug. Worse on recent builds: Vivaldi 7.5 crashes on
`tabs.group()` with a single tab, which is why the native port keeps its "skip plans under 2
tabs" rule — it is a crash guard, not a cosmetic one.

## Tab Stacks: no public API, one sanctioned route

Tab Stacks have no extension API. Two channels create real ones:

- **Channel A — `vivaldi.tabsPrivate.*`**, the drag-and-drop write path, reachable only inside
  the privileged `window.html` context (mods).
- **Channel B — `vivExtData` writes** through `chrome.tabs.update`, an undocumented JSON
  metadata field the UI derives stack membership from. This extension shipped a phase-1
  implementation of it and **retired it**: undocumented, version-sensitive, metadata without a
  native group. See `docs/grouping-port.md` for the decision.

The extension's route is **StackBridge**: a mod, maintained in the author's Awesome-Vivaldi
fork, that runs in `window.html` and wraps Channel A behind a versioned JSON-RPC protocol
(`chrome.runtime.onMessageExternal`, envelope v2, actions `bridge.ping` / `bridge.capabilities`
/ `stacks.list` for reads and the declarative `layout.apply` for writes; every v1 action
remains served for rollback). Its design rationale, security model
(dev build ships **unauthenticated**; sender-id pairing is planned), protocol reference, and
install instructions live upstream and are frozen from this side:

- Repository: `https://github.com/angryLid/Awesome-Vivaldi` (branch `main`), directory `Bridge/`
- `Bridge/README.md` — architecture, security model, verification gates
- `Bridge/API.md` — protocol and action reference for extension developers
- `bridge.sh` — installer (macOS/Linux; Windows unsupported at the time of writing)

What this extension does on Vivaldi today: **bridge or nothing**. If Vivaldi is detected and
the bridge does not answer, a click ends like a missing API key — the run is logged, the
options page opens, and the StackBridge status line carries the warning. Invisible native
groups are not shipped behavior anymore.

## Dedupe and selection on Vivaldi

- Native `groupId`s are untrusted on Vivaldi (invisible, possibly stale): the port declares
  `nativeGroupsTrustworthy: false`, so they never gate candidacy; the dedupe `grouped` rule is
  dropped there (`ignoreGrouped` auto-defaults on). `vivaldi://` pages count as internal URLs.
- Visible stack membership comes from the bridge's `stacks.list` via `listGroups` and excludes
  tabs as `stacked` — never droppable in dedupe, and it covers user-made stacks because the
  bridge owns stack semantics.
- Detection (`lib/vivaldi.ts`) uses five masking-proof-first signals: window-object
  `vivExtData`/`extData` fields (>= 6.7), tab-object fields (legacy), Vivaldi-specific URLs
  (`vivaldi://`, `chrome://vivaldi-webui/`, the internal UI extension origins), then UA-CH
  brands and UA string (only when the user opted out of brand masking).

## Known limitations

- Stack reads through the bridge v1 operate on the UI's *current* window; a multi-window
  mismatch with the clicked window is a documented limitation (H13 in
  `docs/grouping-port.md`), logged, never blocking.
- The dev-build bridge accepts any sender; do not consider stack writes private to this
  extension while authentication is unshipped upstream.
- Stack persistence across restart is Vivaldi's own session format (expected to survive — it
  was the native-group path that was never verified for persistence).
