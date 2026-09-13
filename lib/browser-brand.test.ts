import { describe, expect, it } from 'vitest';
import { classifyBrowserBrand } from './browser-brand';

const chromeUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

describe('classifyBrowserBrand — Gecko path (runtime.getBrowserInfo)', () => {
  it('accepts only self-reported Firefox as native', async () => {
    const env = { nav: {}, getBrowserInfo: async () => ({ name: 'Firefox', vendor: 'Mozilla' }) };
    await expect(classifyBrowserBrand(env)).resolves.toEqual({ state: 'native', label: 'Firefox' });
  });

  it('flags Gecko forks (Waterfox, LibreWolf) as never-tested variants', async () => {
    await expect(classifyBrowserBrand({ nav: {}, getBrowserInfo: async () => ({ name: 'Waterfox' }) })).resolves.toEqual({ state: 'custom', label: 'Waterfox' });
    await expect(classifyBrowserBrand({ nav: {}, getBrowserInfo: async () => ({ name: 'LibreWolf' }) })).resolves.toEqual({ state: 'custom', label: 'LibreWolf' });
  });

  it('falls back to a generic label when the info carries no name', async () => {
    await expect(classifyBrowserBrand({ nav: {}, getBrowserInfo: async () => ({}) })).resolves.toEqual({ state: 'custom', label: 'Gecko-based browser' });
  });
});

describe('classifyBrowserBrand — UA-CH path (Chromium family)', () => {
  const nav = (brands: Array<{ brand?: string; version?: string }>, ua = chromeUa) => ({ nav: { userAgent: ua, userAgentData: { brands } } });

  it('accepts Google Chrome as native', async () => {
    await expect(
      classifyBrowserBrand(nav([{ brand: 'Not.A/Brand', version: '99' }, { brand: 'Chromium', version: '144' }, { brand: 'Google Chrome', version: '144' }])),
    ).resolves.toEqual({ state: 'native', label: 'Chrome' });
  });

  it('accepts unbranded Chromium as native', async () => {
    await expect(classifyBrowserBrand(nav([{ brand: 'Not A;Brand', version: '24' }, { brand: 'Chromium', version: '144' }]))).resolves.toEqual({
      state: 'native',
      label: 'Chromium',
    });
  });

  it('flags every vendor brand as a never-tested variant — Edge, Opera, Brave, Arc, Yandex', async () => {
    await expect(classifyBrowserBrand(nav([{ brand: 'Chromium', version: '144' }, { brand: 'Microsoft Edge', version: '144' }]))).resolves.toEqual({
      state: 'custom',
      label: 'Microsoft Edge',
    });
    await expect(classifyBrowserBrand(nav([{ brand: 'Chromium', version: '120' }, { brand: 'Opera', version: '120' }]))).resolves.toEqual({ state: 'custom', label: 'Opera' });
    await expect(classifyBrowserBrand(nav([{ brand: 'Chromium', version: '130' }, { brand: 'Brave', version: '1' }]))).resolves.toEqual({ state: 'custom', label: 'Brave' });
    await expect(classifyBrowserBrand(nav([{ brand: 'Chromium', version: '130' }, { brand: 'Arc', version: '2' }]))).resolves.toEqual({ state: 'custom', label: 'Arc' });
    await expect(classifyBrowserBrand(nav([{ brand: 'Chromium', version: '130' }, { brand: 'Yandex', version: '24' }]))).resolves.toEqual({ state: 'custom', label: 'Yandex' });
  });

  it('drops GREASE entries whatever their spelling', async () => {
    await expect(classifyBrowserBrand(nav([{ brand: 'Not/A)Brand', version: '99' }, { brand: 'Chromium', version: '144' }]))).resolves.toEqual({
      state: 'native',
      label: 'Chromium',
    });
  });

  it('never grants native status from the UA string alone — no UA-CH means unprovable', async () => {
    await expect(classifyBrowserBrand({ nav: { userAgent: chromeUa } })).resolves.toEqual({ state: 'custom', label: 'Unidentified browser' });
  });

  it('names Safari from the UA when UA-CH is absent', async () => {
    const safariUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
    await expect(classifyBrowserBrand({ nav: { userAgent: safariUa } })).resolves.toEqual({ state: 'custom', label: 'Safari' });
  });

  it('tolerates missing or malformed brand entries', async () => {
    await expect(classifyBrowserBrand({ nav: { userAgentData: { brands: [{}] } } })).resolves.toEqual({ state: 'custom', label: 'Unidentified browser' });
  });
});
