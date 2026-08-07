// @vitest-environment jsdom
//
// The options page has one job that can go wrong quietly: the permission
// request. It must happen inside the click and before anything is awaited —
// a handler stops counting as user-initiated the moment it waits on a promise,
// and permissions.request then fails even when the permission would have been
// granted. That is the bug that makes a feature "just not work".

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { rulesBackend } from './helpers/rules-backend.js';
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

async function mount({
  firefox = true,
  granted = false,
  grant = true,
  settings = {},
  rules = {},
  containers = [],
} = {}) {
  document.documentElement.innerHTML = HTML.replace(/<!doctype html>/i, '');
  requested = [];
  removed = [];
  let held = granted;
  globalThis.chrome = {
    runtime: {
      getURL: () => `${firefox ? 'moz' : 'chrome'}-extension://linkward/`,
      // The pages ask the background to write; this is the background.
      sendMessage: (msg) => rulesBackend()(msg),
    },
    storage: { sync: makeArea({ settings, rules }), local: makeArea() },
  };
  globalThis.browser = {
    contextualIdentities: { query: async () => containers },
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
const stored2 = () => globalThis.chrome.storage.sync.store;

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

const WORK = { cookieStoreId: 'firefox-container-2', name: 'Work', color: 'blue' };
const HOME = { cookieStoreId: 'firefox-container-3', name: 'Home', color: 'green' };
const rows = () => [...document.querySelectorAll('#rules li')];
const rowFor = (host) => rows().find((li) => li.querySelector('.host')?.textContent === host);

describe('the remembered sites', () => {
  const two = {
    'example.com': { container: 'Work', cookieStoreId: WORK.cookieStoreId },
    'news.example': { container: null, cookieStoreId: '', plain: true },
  };

  it('says so plainly when there are none', async () => {
    await mount({ granted: true });
    expect($('rules-empty').hidden).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('lists them, sorted, with where each one opens', async () => {
    await mount({ granted: true, rules: two, containers: [WORK, HOME] });
    expect(rows().map((li) => li.querySelector('.host').textContent)).toEqual([
      'example.com',
      'news.example',
    ]);
    expect(rowFor('example.com').querySelector('select').value).toBe(WORK.cookieStoreId);
    expect(rowFor('news.example').querySelector('select').value).toBe('');
  });

  it('shows the host as text, never as markup', async () => {
    // A host arrives from a page the user was sent to, so it is not ours.
    await mount({
      granted: true,
      rules: { '<img src=x onerror=alert(1)>.test': { container: 'Work' } },
      containers: [WORK],
    });
    expect(document.querySelector('#rules img')).toBeNull();
    expect(rows()[0].querySelector('.host').textContent).toContain('<img');
  });

  it('names a container this browser does not have instead of pretending', async () => {
    // Synced from another machine, or renamed since. Showing it as "No
    // container" would be a lie about what will happen to that host.
    await mount({
      granted: true,
      rules: { 'example.com': { container: 'Admin', cookieStoreId: 'gone' } },
      containers: [WORK],
    });
    const select = rowFor('example.com').querySelector('select');
    expect(select.value).toBe('__missing__');
    expect(select.selectedOptions[0].textContent).toMatch(/Admin.*not here/i);
  });

  it('leaves that rule alone rather than rewriting it', async () => {
    // Re-selecting the placeholder must not turn a rule for a container that
    // exists elsewhere into "no container" here.
    await mount({
      granted: true,
      rules: { 'example.com': { container: 'Admin', cookieStoreId: 'gone' } },
      containers: [WORK],
    });
    const select = rowFor('example.com').querySelector('select');
    select.value = '__missing__';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(stored2().rules['example.com'].container).toBe('Admin');
  });

  it('moves a host to another container', async () => {
    await mount({ granted: true, rules: two, containers: [WORK, HOME] });
    const select = rowFor('example.com').querySelector('select');
    select.value = HOME.cookieStoreId;
    select.dispatchEvent(new Event('change'));
    await settle();
    // The NAME is what is stored: the id means nothing on another machine.
    expect(stored2().rules['example.com']).toEqual({
      container: 'Home',
      cookieStoreId: HOME.cookieStoreId,
    });
  });

  it('forgets one, and only that one', async () => {
    await mount({ granted: true, rules: two, containers: [WORK, HOME] });
    rowFor('example.com').querySelector('button').click();
    // The row goes when the list is read back, which is two awaits past the write.
    await settle(20);
    expect(Object.keys(stored2().rules)).toEqual(['news.example']);
    expect(rows()).toHaveLength(1);
  });
});

describe('the settings file, from the page', () => {
  function catchDownload() {
    const clicks = [];
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = real(tag);
      if (tag === 'a') el.click = () => clicks.push({ href: el.href, name: el.download });
      return el;
    });
    return clicks;
  }

  it('offers a file named for the day, and lets the blob go again', async () => {
    // A blob URL that is never revoked is held for as long as the page is open.
    await mount({ granted: true, rules: { 'a.test': { container: 'Work' } } });
    const clicks = catchDownload();
    $('export').click();
    await settle(20);
    expect(clicks[0].name).toMatch(/^linkward-settings-\d{4}-\d{2}-\d{2}\.json$/);
    // Revoked a tick later, not in the same turn as the click — doing it there
    // has been known to cancel the download it just started.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('takes a file back in and shows it straight away', async () => {
    await mount({ granted: true });
    const file = {
      text: async () =>
        JSON.stringify({
          format: 'linkward-settings',
          version: 1,
          settings: { neverAsk: ['imported.test'], rememberPrompt: 'ticked' },
          rules: { 'b.test': { container: 'Work', cookieStoreId: 'firefox-container-2' } },
        }),
    };
    Object.defineProperty($('import-file'), 'files', { value: [file], configurable: true });
    $('import-file').dispatchEvent(new Event('change'));
    await settle(30);
    expect(stored2().rules['b.test'].container).toBe('Work');
    expect($('never').value).toBe('imported.test');
    expect($('remember-prompt').value).toBe('ticked');
  });

  it('says what was wrong with a file it cannot read, and changes nothing', async () => {
    await mount({ granted: true, settings: { neverAsk: ['kept.test'] } });
    const file = { text: async () => '{"format":"something-else"}' };
    Object.defineProperty($('import-file'), 'files', { value: [file], configurable: true });
    $('import-file').dispatchEvent(new Event('change'));
    await settle(30);
    expect($('status').textContent).toMatch(/not a linkward settings file/i);
    expect($('never').value).toBe('kept.test');
  });

  it('survives a file that is not JSON at all', async () => {
    await mount({ granted: true });
    const file = { text: async () => 'not json {' };
    Object.defineProperty($('import-file'), 'files', { value: [file], configurable: true });
    $('import-file').dispatchEvent(new Event('change'));
    await settle(30);
    expect($('status').textContent).toMatch(/could not import/i);
  });

  it('clears the file input, so the same file can be chosen twice', async () => {
    // Without this, picking the same file again fires no change event and the
    // button silently does nothing.
    await mount({ granted: true });
    const file = { text: async () => '{}' };
    Object.defineProperty($('import-file'), 'files', { value: [file], configurable: true });
    $('import-file').dispatchEvent(new Event('change'));
    await settle(30);
    expect($('import-file').value).toBe('');
  });
});

describe('when the browser refuses to store something', () => {
  it('says so instead of leaving the wrong answer on screen', async () => {
    // Synced storage has a size limit and can refuse. A page about where your
    // sessions open must never show one thing while another applies.
    await mount({
      granted: true,
      rules: { 'example.com': { container: 'Work', cookieStoreId: WORK.cookieStoreId } },
      containers: [WORK, HOME],
    });
    globalThis.chrome.storage.sync.set = async () => {
      throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
    };
    const select = rowFor('example.com').querySelector('select');
    select.value = HOME.cookieStoreId;
    select.dispatchEvent(new Event('change'));
    await settle(30);
    expect($('status').textContent).toMatch(/could not save that.*quota/i);
    // And the row is redrawn from what is really stored, not from the click.
    expect(rowFor('example.com').querySelector('select').value).toBe(WORK.cookieStoreId);
  });

  it('says so when a host cannot be forgotten', async () => {
    await mount({
      granted: true,
      rules: { 'example.com': { container: 'Work' } },
      containers: [WORK],
    });
    globalThis.chrome.storage.sync.set = async () => {
      throw new Error('nope');
    };
    rowFor('example.com').querySelector('button').click();
    await settle(30);
    expect($('status').textContent).toMatch(/could not forget example\.com/i);
  });
});

describe('when the settings cannot be read', () => {
  it('refuses to export rather than write an empty file over them later', async () => {
    // A failed read turned into `{}` is a valid-looking backup of nothing,
    // reported as a success, and restored one day over the real thing.
    await mount({ granted: true, rules: { 'a.test': { container: 'Work' } } });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.chrome.storage.sync.get = async () => {
      throw new Error('storage is unavailable');
    };
    $('export').click();
    await settle(30);
    expect($('status').textContent).toMatch(/could not read the settings/i);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('refuses to import rather than reset what the file does not carry', async () => {
    // `enabled` and `lastContainer` are never in the file. Falling back to the
    // defaults for them would switch the feature off as a side effect.
    await mount({ granted: true, settings: { enabled: true, neverAsk: ['kept.test'] } });
    globalThis.chrome.storage.sync.get = async () => {
      throw new Error('storage is unavailable');
    };
    const file = {
      text: async () => JSON.stringify({ format: 'linkward-settings', version: 1, rules: {} }),
    };
    Object.defineProperty($('import-file'), 'files', { value: [file], configurable: true });
    $('import-file').dispatchEvent(new Event('change'));
    await settle(30);
    expect($('status').textContent).toMatch(/could not import/i);
    expect(stored()?.enabled).toBe(true);
  });
});

describe('the corners of the settings page', () => {
  it('opens the file chooser from the Import button', async () => {
    // The visible button is not the file input: the real one is hidden because
    // a bare file input cannot be styled, so the click has to be forwarded.
    await mount({ granted: true });
    const opened = vi.fn();
    $('import-file').click = opened;
    $('import').click();
    await settle();
    expect(opened).toHaveBeenCalled();
  });

  it('names a container-less rule that has an id nobody recognises', async () => {
    // Written before names were stored, on a machine that is not this one.
    await mount({
      granted: true,
      rules: { 'old.test': { container: null, cookieStoreId: 'firefox-container-88' } },
      containers: [WORK],
    });
    const select = rowFor('old.test').querySelector('select');
    expect(select.value).toBe('__missing__');
    expect(select.selectedOptions[0].textContent).toMatch(/unknown container/i);
  });

  it('shows a rule for a container that has no colour we know', async () => {
    // Firefox renames colours between releases; an unknown one gets no dot
    // rather than a wrong one, and the container is still named in words.
    await mount({
      granted: true,
      rules: { 'a.test': { container: 'Odd' } },
      containers: [{ cookieStoreId: 'firefox-container-9', name: 'Odd', color: 'chartreuse' }],
    });
    expect(rowFor('a.test').querySelector('.dot').style.background).toBe('');
    expect(rowFor('a.test').querySelector('select').value).toBe('firefox-container-9');
  });

  it('comes up even when the settings cannot be read at all', async () => {
    // A page that throws on load leaves somebody with no way to switch the
    // thing off, which is worse than a page with the defaults in it.
    await mount({ granted: true });
    globalThis.chrome.storage.sync.get = async () => {
      throw new Error('storage is unavailable');
    };
    await mountAgain();
    expect($('never').value).toBe('');
    expect($('rules-empty').hidden).toBe(false);
  });

  it('reports a failure that is not an Error object', async () => {
    // Extension APIs reject with plain strings often enough that `err.message`
    // alone prints "undefined" where the reason should be.
    await mount({ granted: true, rules: { 'a.test': { container: 'Work' } }, containers: [WORK] });
    globalThis.chrome.storage.sync.set = async () => {
      throw 'nope, full disk';
    };
    rowFor('a.test').querySelector('button').click();
    await settle(30);
    expect($('status').textContent).toMatch(/nope, full disk/);
  });
});

/** Re-run the page against the chrome object already in place. */
async function mountAgain() {
  document.documentElement.innerHTML = HTML.replace(/<!doctype html>/i, '');
  vi.resetModules();
  await import('../src/options/options.js');
  await settle(20);
}

describe('changing where one host opens', () => {
  it('sends that host alone, not a snapshot of every rule', async () => {
    // Reading the whole map here and sending it all back would put the read
    // OUTSIDE the queue that exists to make this safe: a rule the picker pinned
    // between our read and our write would be erased by a snapshot older than
    // it. The background reads and writes inside its own queue.
    const sent = [];
    await mount({
      granted: true,
      rules: { 'example.com': { container: 'Work', cookieStoreId: WORK.cookieStoreId } },
      containers: [WORK, HOME],
    });
    const backend = globalThis.chrome.runtime.sendMessage;
    globalThis.chrome.runtime.sendMessage = (msg) => {
      sent.push(msg);
      return backend(msg);
    };
    const select = rowFor('example.com').querySelector('select');
    select.value = HOME.cookieStoreId;
    select.dispatchEvent(new Event('change'));
    await settle(30);

    expect(sent.map((m) => m.type)).toEqual(['linkward:rules:set']);
    expect(sent[0]).toMatchObject({ host: 'example.com', rule: { container: 'Home' } });
  });

  it('still keeps the whole-map write for an import, where replacing is the point', async () => {
    const sent = [];
    await mount({ granted: true, rules: { 'gone.test': { container: 'Work' } } });
    const backend = globalThis.chrome.runtime.sendMessage;
    globalThis.chrome.runtime.sendMessage = (msg) => {
      sent.push(msg);
      return backend(msg);
    };
    const file = {
      text: async () =>
        JSON.stringify({
          format: 'linkward-settings',
          version: 1,
          rules: { 'kept.test': { container: 'Work' } },
        }),
    };
    Object.defineProperty($('import-file'), 'files', { value: [file], configurable: true });
    $('import-file').dispatchEvent(new Event('change'));
    await settle(30);
    expect(sent.map((m) => m.type)).toContain('linkward:rules:replace');
    expect(Object.keys(stored2().rules)).toEqual(['kept.test']);
  });
});
