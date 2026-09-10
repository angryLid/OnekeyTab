interface UaData {
  brands?: Array<{ brand?: string; version?: string }>;
}

interface NavLike {
  userAgent?: string;
  userAgentData?: UaData;
}

/**
 * True when any queried tab object carries Vivaldi's injected property (`vivExtData` is the
 * current name, `exData` the legacy one). Independent of the User-Agent brand masking Vivaldi
 * applies by default (docs/vivaldi-compatibility.md).
 */
export function hasVivaldiTabSignals(tabs: ReadonlyArray<object>): boolean {
  return tabs.some((tab) => 'vivExtData' in tab || 'exData' in tab);
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
 * Best-effort Vivaldi detection for extension contexts: tab-object signals first (the reliable
 * one), then UA/brand checks (works only when the user opted in to branding). A masked Vivaldi
 * where tabs lack vivExtData is indistinguishable — provide a manual settings override.
 */
export function isVivaldi(tabs: ReadonlyArray<object>, nav: NavLike = navigator): boolean {
  return hasVivaldiTabSignals(tabs) || isVivaldiFromNav(nav);
}
