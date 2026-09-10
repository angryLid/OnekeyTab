import { describe, expect, it } from 'vitest';
import { describeVivaldiSignals, hasVivaldiTabSignals, hasVivaldiWindowSignals, isVivaldi } from './vivaldi';

const chromeNav = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' };

describe('hasVivaldiTabSignals', () => {
  it('fires on the vivExtData JSON-string field, the legacy exData alias, and pre-5.3 extData', () => {
    expect(hasVivaldiTabSignals([{ vivExtData: '{"workspaceId":123}' }])).toBe(true);
    expect(hasVivaldiTabSignals([{ exData: '{}' }])).toBe(true);
    expect(hasVivaldiTabSignals([{ extData: 'legacy' }])).toBe(true);
  });

  it('fires on the vivaldi:// scheme and the chrome://vivaldi-webui/ start-page URL', () => {
    expect(hasVivaldiTabSignals([{ url: 'vivaldi://about/' }])).toBe(true);
    expect(hasVivaldiTabSignals([{ url: 'chrome://vivaldi-webui/startpage?section=Speed-dials' }])).toBe(true);
    expect(hasVivaldiTabSignals([{ url: 'CHROME://VIVALDI-WEBUI/startpage' }])).toBe(true);
  });

  it('fires on tabs served from the internal Vivaldi UI extension origin (current and legacy IDs)', () => {
    expect(hasVivaldiTabSignals([{ url: 'chrome-extension://mpognobbkildjkofajifpdfhcoklimli/browser.html' }])).toBe(true);
    expect(hasVivaldiTabSignals([{ url: 'chrome-extension://mpognobbkildjkoffnifgbdaajjmofk/index.html' }])).toBe(true);
  });

  it('does not fire on ordinary pages or unrelated internal pages', () => {
    expect(hasVivaldiTabSignals([{ url: 'https://example.com/' }, { url: 'chrome://newtab/' }, { url: 'edge://settings/' }])).toBe(false);
    expect(hasVivaldiTabSignals([{ url: 'chrome-extension://lnbjajkbekhkgablenknhapphbdbldeh/newtab.html' }])).toBe(false);
  });

  it('ignores tabs with missing or empty URLs', () => {
    expect(hasVivaldiTabSignals([{}, { url: '' }, { url: null }])).toBe(false);
  });

  it('needs only one signal among all tabs', () => {
    expect(hasVivaldiTabSignals([{ url: 'https://a.com/' }, { url: 'vivaldi://settings/' }])).toBe(true);
  });
});

describe('hasVivaldiWindowSignals', () => {
  it('fires on the window-object field (the strongest signal on Vivaldi >= 6.7, where tab-level vivExtData was removed)', () => {
    expect(hasVivaldiWindowSignals([{ id: 1, vivExtData: '{"state":1}' }])).toBe(true);
    expect(hasVivaldiWindowSignals([{ id: 1 }, { id: 2, vivExtData: '{}' }])).toBe(true);
    expect(hasVivaldiWindowSignals([{ id: 1 }, { id: 2 }])).toBe(false);
  });

  it('fires on the legacy window-level extData field (pre-rename builds)', () => {
    expect(hasVivaldiWindowSignals([{ id: 1, extData: '{}' }])).toBe(true);
  });
});

describe('describeVivaldiSignals', () => {
  it('reports exactly which probes fired', () => {
    expect(describeVivaldiSignals([{ vivExtData: '{}' }, { url: 'vivaldi://about/' }], { userAgent: 'Chrome Vivaldi/8.2' }).signals.sort()).toEqual(['tab-field', 'tab-url', 'ua-string']);
    expect(describeVivaldiSignals([], chromeNav).signals).toEqual([]);
  });

  it('reports the window-field signal independently of tab signals', () => {
    expect(describeVivaldiSignals([{ url: 'https://a.com/' }], chromeNav, [{ id: 1, vivExtData: '{}' }]).signals).toEqual(['window-field']);
    expect(describeVivaldiSignals([{ url: 'https://a.com/' }], chromeNav, [{ id: 1 }]).signals).toEqual([]);
  });

  it('distinguishes the UA-CH brand signal from the UA string signal', () => {
    expect(describeVivaldiSignals([], { userAgent: 'Chrome/140', userAgentData: { brands: [{ brand: 'Vivaldi', version: '8' }] } }).signals).toEqual(['ua-brand']);
  });
});

describe('isVivaldi (combined)', () => {
  it('detects Vivaldi 6.7+ via the window-object signal when tabs carry nothing', () => {
    const tabs = [{ id: 1, url: 'https://example.com/' }];
    const windows = [{ id: 10, vivExtData: '{" focused":true}' }];
    expect(isVivaldi(tabs, chromeNav, windows)).toBe(true);
  });

  it('detects a fully masked Vivaldi via the tab-url signal alone', () => {
    const tabs = [{ id: 1, url: 'chrome://vivaldi-webui/startpage' }];
    expect(isVivaldi(tabs, chromeNav)).toBe(true);
  });

  it('stays negative on a plain Chrome window with no Vivaldi signals', () => {
    const tabs = [{ id: 1, url: 'https://example.com/' }, { id: 2, url: 'chrome://settings/' }];
    expect(isVivaldi(tabs, chromeNav)).toBe(false);
  });
});
