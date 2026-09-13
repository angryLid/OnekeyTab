# Onekey Tab

One feature: click the toolbar icon and AI groups your open tabs into titled tab groups.

## Install

**Option A — download a release:** grab the zip for your browser from
[GitHub Releases](https://github.com/angryLid/OnekeyTab/releases), unzip it.

**Option B — build from source:**

```bash
git clone https://github.com/angryLid/OnekeyTab.git
cd OnekeyTab
pnpm install
pnpm build         # Chrome; use `pnpm build:firefox` for Firefox
```

The unpacked build lands in `.output/chrome-mv3`.

Then load it: open `chrome://extensions` (or `about:debugging` → "This Firefox" on Firefox),
enable **Developer mode**, click **Load unpacked**, and select the unzipped folder (Option A)
or `.output/chrome-mv3` (Option B).

## Set the API key

Click the extension icon — the settings page opens. Paste an
[OpenRouter API key](https://openrouter.ai/settings/keys) and click **Save & Verify**. Done —
click the icon again on any window to group its tabs.
