interface UaData {
  brands?: Array<{ brand?: string; version?: string }>;
}

interface NavLike {
  userAgent?: string;
  userAgentData?: UaData;
}

interface UrlLike {
  url?: string | null;
}

/**
 * Since ~Vivaldi 6.7 (2024-05) the per-tab injected property was removed; the same field now
 * lives on the chrome.windows.Window object instead (confirmed by Violentmonkey's detection
 * code, src/background/utils/ua.js: `wnd.vivExtData || wnd.extData`).
 */
const VIVALDI_WINDOW_FIELDS: ReadonlyArray<string> = ['vivExtData', 'extData'];

/**
 * Vivaldi injects per-tab Vivaldi state into every chrome.tabs.Tab handed to extensions.
 * The field name has changed across versions: `extData` (pre-5.3), `exData` (legacy alias),
 * `vivExtData` (current; a JSON string). Presence of any of them proves Vivaldi regardless
 * of User-Agent brand masking.
 */
const VIVALDI_TAB_FIELDS: ReadonlyArray<string> = ['vivExtData', 'exData', 'extData'];

/**
 * Vivaldi's entire UI runs as an internal Chromium extension; tabs opened by the UI (start
 * page, settings, notes...) surface this origin in tab.url. Two IDs exist in the wild: the
 * current one and the pre-5.x-era one.
 */
const VIVALDI_UI_EXTENSION_IDS: ReadonlyArray<string> = [
  'mpognobbkildjkofajifpdfhcoklimli',
  'mpognobbkildjkoffnifgbdaajjmofk',
];

/**
 * URL prefixes unique to Vivaldi: its own scheme, plus the fake `chrome://vivaldi-webui/` URL
 * the web UI reports to chrome.tabs.query for the start page / new tab (mirrors Opera's
 * chrome://startpageshared/). Both survive User-Agent brand masking.
 */
const VIVALDI_URL_PREFIXES: ReadonlyArray<string> = [
  'vivaldi:',
  'chrome://vivaldi-webui/',
];

function hasVivaldiUrlSignal(tab: UrlLike): boolean {
  const url = typeof tab.url === 'string' ? tab.url.toLowerCase() : '';
  if (url.length === 0) return false;
  if (VIVALDI_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
  return VIVALDI_UI_EXTENSION_IDS.some((id) => url.startsWith(`chrome-extension://${id}/`));
}

export interface VivaldiSignals {
  /** Which probe fired: 'window-field', 'tab-field', 'tab-url', 'ua-brand', 'ua-string'. */
  signals: string[];
}

/**
 * True when any window object carries Vivaldi's injected property — the strongest signal on
 * Vivaldi >= 6.7, where the tab-level field no longer exists. Masking-proof.
 */
export function hasVivaldiWindowSignals(windows: ReadonlyArray<object>): boolean {
  return windows.some((wnd) => VIVALDI_WINDOW_FIELDS.some((field) => field in wnd));
}

/**
 * Collect every Vivaldi signal visible in the given inputs, for both detection and
 * diagnostics (the log can show exactly which probe identified the browser).
 */
export function describeVivaldiSignals(
  tabs: ReadonlyArray<object>,
  nav: NavLike = navigator,
  windows: ReadonlyArray<object> = [],
): VivaldiSignals {
  const signals: string[] = [];
  if (hasVivaldiWindowSignals(windows)) signals.push('window-field');
  if (tabs.some((tab) => VIVALDI_TAB_FIELDS.some((field) => field in tab))) signals.push('tab-field');
  if (tabs.some(hasVivaldiUrlSignal)) signals.push('tab-url');
  const brands = nav.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some((b) => /vivaldi/i.test(String(b.brand ?? '')))) signals.push('ua-brand');
  if (/vivaldi/i.test(nav.userAgent ?? '')) signals.push('ua-string');
  return { signals };
}

/**
 * True when any queried tab object carries a Vivaldi-injected property or a Vivaldi-specific
 * URL (vivaldi:// scheme, chrome://vivaldi-webui/ start page, or the internal UI extension
 * origin). On Vivaldi >= 6.7 prefer hasVivaldiWindowSignals — the tab-level field is gone.
 * Independent of the User-Agent brand masking Vivaldi applies by default
 * (docs/vivaldi.md).
 */
export function hasVivaldiTabSignals(tabs: ReadonlyArray<object>): boolean {
  return tabs.some(
    (tab) => VIVALDI_TAB_FIELDS.some((field) => field in tab) || hasVivaldiUrlSignal(tab as UrlLike),
  );
}

/**
 * User-Agent based check. Vivaldi masks its branding by default (in both the UA string and the
 * UA-CH brand list), so this only succeeds when the user opted in via Settings > Network >
 * User Agent Brand Masking or is on a partner site. Both signals are checked — never
 * short-circuit on the brand list alone.
 */
export function isVivaldiFromNav(nav: NavLike = navigator): boolean {
  const brands = nav.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some((b) => /vivaldi/i.test(String(b.brand ?? '')))) return true;
  return /vivaldi/i.test(nav.userAgent ?? '');
}

/**
 * Best-effort Vivaldi detection for extension contexts: window-object and tab signals first
 * (masking-proof), then UA/brand checks (work only when the user opted in to branding). A
 * masked Vivaldi whose windows/tabs carry none of the above is indistinguishable — provide a
 * manual settings override.
 */
export function isVivaldi(
  tabs: ReadonlyArray<object>,
  nav: NavLike = navigator,
  windows: ReadonlyArray<object> = [],
): boolean {
  return hasVivaldiWindowSignals(windows) || hasVivaldiTabSignals(tabs) || isVivaldiFromNav(nav);
}
