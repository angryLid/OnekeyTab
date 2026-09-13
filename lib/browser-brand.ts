// Wxt-free and strict: green requires proof. Gecko browsers must self-identify as Firefox via
// runtime.getBrowserInfo (not implemented in Chrome or Safari, per mdn/browser-compat-data);
// Chromium browsers must present a UA-CH brand list carrying no vendor brand besides Google
// Chrome. Every other variant — Edge, Opera, Brave, Arc, Whale, Yandex, Gecko forks, Safari,
// anything unprovable (UA string alone proves nothing, since forks mask their UA) — is flagged
// as never-tested. Vivaldi is classified upstream by lib/vivaldi.ts (masking-proof window/tab
// fields) and never reaches this module.

interface UaData {
  brands?: Array<{ brand?: string; version?: string }>;
}

interface NavLike {
  userAgent?: string;
  userAgentData?: UaData;
}

export interface BrowserInfoLike {
  name?: string;
  vendor?: string;
}

export interface BrowserBrandEnv {
  nav: NavLike;
  /** browser.runtime.getBrowserInfo when the engine provides it (Gecko only); injectable for tests. */
  getBrowserInfo?: () => Promise<BrowserInfoLike>;
}

/** Label for the cannot-prove case; shared by the classifier and the options copy. */
export const UNIDENTIFIED_BROWSER = 'Unidentified browser';

/** Green (`native`) only for proven Chrome/Chromium/Firefox; every other case is `custom`. */
export type BrandVerdict =
  | { state: 'native'; label: string }
  | { state: 'custom'; label: string };

export async function classifyBrowserBrand(env: BrowserBrandEnv): Promise<BrandVerdict> {
  if (env.getBrowserInfo) {
    const info = await env.getBrowserInfo();
    const name = typeof info.name === 'string' && info.name.trim().length > 0 ? info.name.trim() : 'Gecko-based browser';
    return name === 'Firefox' ? { state: 'native', label: 'Firefox' } : { state: 'custom', label: name };
  }
  return fromUachBrands(env.nav);
}

function fromUachBrands(nav: NavLike): BrandVerdict {
  const brands = (nav.userAgentData?.brands ?? [])
    .map((entry) => String(entry.brand ?? '').trim())
    .filter((brand) => brand.length > 0);
  if (brands.length > 0) {
    // Vendor brands left after dropping GREASE entries and the two native Chromium identities.
    const vendor = brands.filter((brand) => !isGreaseBrand(brand) && !/^(chromium|google chrome)$/i.test(brand));
    if (vendor.length === 0) {
      return { state: 'native', label: brands.some((brand) => /google chrome/i.test(brand)) ? 'Chrome' : 'Chromium' };
    }
    // Unreachable in practice (vendor is non-empty here); the fallback keeps the type honest.
    return { state: 'custom', label: vendor[0] ?? 'Unidentified browser' };
  }
  // No UA-CH at all: native status is unprovable, so only Safari earns a named caveat.
  const ua = nav.userAgent ?? '';
  if (/safari\//i.test(ua) && !/chrome|chromium|edg\//i.test(ua)) return { state: 'custom', label: 'Safari' };
  return { state: 'custom', label: UNIDENTIFIED_BROWSER };
}

/** UA-CH GREASE entries ("Not.A/Brand", "Not A;Brand", "Not/A)Brand", ...) carry no vendor information. */
function isGreaseBrand(brand: string): boolean {
  return /^not[^a-z]*a[^a-z]*brand$/i.test(brand);
}
