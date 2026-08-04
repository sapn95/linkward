// @vitest-environment jsdom
//
// The options page has one job that can go wrong quietly: the permission
// request. It must happen inside the click and before anything is awaited —
// a handler stops counting as user-initiated the moment it waits on a promise,
// and permissions.request then fails even when the permission would have been
// granted. That is the bug that makes a feature "just not work".

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HTML = readFileSync(join(process.cwd(), 'src/options/options.html'), 'utf8');

function makeArea(seed = {}) {
  const store = { ...seed };
  return {
    store,
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
  };
}

let requested;
let removed;

async function mount({ firefox = true, granted = false, grant = true, settings = {} } = {}) {
  document.documentElement.innerHTML = HTML.replace(/<!doctype html>/i, '');
  requested = [];
  removed = [];
  let held = granted;
  globalThis.chrome = {
    runtime: { getURL: () => `${firefox ? 'moz' : 'chrome'}-extension://linkward/` },
    storage: { sync: makeArea({ settings }), local: makeArea() },
  };
  globalThis.browser = {
    permissions: {
      contains: vi.fn(async () => held),
      request: vi.fn(async (p) => {
        requested.push(p);
        held = grant;
        return grant;
      }),
      remove: vi.fn(async (p) => {
        removed.push(p);
        held = false;
        return true;
      }),
    },
  };
  vi.resetModules();
  await import('../src/options/options.js');
  await settle();
}

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const $ = (id) => document.getElementById(id);
const stored = () => globalThis.chrome.storage.sync.store.settings;

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.browser;
  vi.restoreAllMocks();
});

describe('the first-run notice', () => {
  it('is shown while the browser grants nothing', async () => {
    // Without it a new install is indistinguishable from a broken one: links
    // keep opening exactly as they did, and nothing says why.
    await mount({ granted: false });
    expect($('setup').hidden).toBe(false);
    expect($('setup').textContent).toMatch(/not watching anything yet/i);
  });

  it('is gone once the access is really held', async () => {
    await mount({ granted: true, settings: { enabled: true } });
    expect($('setup').hidden).toBe(true);
  });

  it('goes away the moment the access is granted, without a reload', async () => {
    await mount({ granted: false });
    $('enabled').checked = true;
    $('enabled').dispatchEvent(new Event('change'));
    await settle();
    expect($('setup').hidden).toBe(true);
  });

  it('comes back when the access is refused', async () => {
    await mount({ grant: false });
    $('enabled').checked = true;
    $('enabled').dispatchEvent(new Event('change'));
    await settle();
    expect($('setup').hidden).toBe(false);
  });
});

describe('the switch tells the truth', () => {
  it('is off when the browser holds nothing, whatever was stored', async () => {
    // The access can be revoked in the browser's own add-on settings behind our
    // back. A tick that lied about that would be worse than no tick.
    await mount({ granted: false, settings: { enabled: true } });
    expect($('enabled').checked).toBe(false);
  });

  it('is on only when the browser really grants it', async () => {
    await mount({ granted: true, settings: { enabled: true } });
    expect($('enabled').checked).toBe(true);
  });
});

describe('asking for the access', () => {
  it('asks for everything in ONE request, inside the click', async () => {
    // Two requests can never work: the first await costs the handler its
    // user-initiated status and the second is refused outright.
    await mount({ firefox: true });
    $('enabled').checked = true;
    $('enabled').dispatchEvent(new Event('change'));
    await settle();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toEqual({
      origins: ['<all_urls>'],
      permissions: ['webRequest', 'webRequestBlocking'],
    });
    expect(stored().enabled).toBe(true);
  });

  it('asks for webNavigation on Chrome, which has no blocking form', async () => {
    await mount({ firefox: false });
    $('enabled').checked = true;
    $('enabled').dispatchEvent(new Event('change'));
    await settle();
    expect(requested[0].permissions).toEqual(['webNavigation']);
  });

  it('puts the switch back and stays off when the access is refused', async () => {
    // Leaving it ticked would promise something the extension cannot do.
    await mount({ grant: false });
    $('enabled').checked = true;
    $('enabled').dispatchEvent(new Event('change'));
    await settle();
    expect($('enabled').checked).toBe(false);
    expect($('status').textContent).toMatch(/denied/i);
    expect(stored()?.enabled).not.toBe(true);
  });

  it('hands the access back when switched off', async () => {
    // Off must mean off: no listener, and nothing held.
    await mount({ granted: true, settings: { enabled: true } });
    $('enabled').checked = false;
    $('enabled').dispatchEvent(new Event('change'));
    await settle();
    expect(removed).toHaveLength(1);
    expect(removed[0].origins).toEqual(['<all_urls>']);
    expect(stored().enabled).toBe(false);
  });
});

describe('the never-ask list', () => {
  it('saves one host per line, dropping the blanks', async () => {
    // An empty line that survived would be a pattern matching everything, which
    // would silently switch the extension off.
    await mount({ granted: true, settings: { enabled: true } });
    $('never').value = 'example.com\n\n  intranet.local  \n';
    $('never').dispatchEvent(new Event('change'));
    await settle();
    expect(stored().neverAsk).toEqual(['example.com', 'intranet.local']);
  });

  it('shows what was already saved', async () => {
    await mount({ granted: true, settings: { neverAsk: ['a.test', 'b.test'] } });
    expect($('never').value).toBe('a.test\nb.test');
  });
});

describe('what the page admits to', () => {
  it('says on Chrome that it cannot stop the request or reach a profile', async () => {
    await mount({ firefox: false });
    expect($('honest').textContent).toMatch(/removed the ability to stop a request/i);
    expect($('honest').textContent).toMatch(/another Chrome\s+profile/i);
  });

  it('says on Firefox that the page is never fetched', async () => {
    await mount({ firefox: true });
    expect($('honest').textContent).toMatch(/before it is sent/i);
  });
});
