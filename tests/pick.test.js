// @vitest-environment jsdom
//
// The picker is `web_accessible`: any website can navigate to it with a URL of
// its choosing. So the tests that matter most here are not "does the button
// work" but "what does it do with a hostile query string".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { rulesBackend } from './helpers/rules-backend.js';
import { join } from 'node:path';

// From the project root, not from import.meta.url: under the jsdom environment
// that is an http URL and readFileSync will not take it.
const HTML = readFileSync(join(process.cwd(), 'src/pick/pick.html'), 'utf8');
const WORK = 'firefox-container-2';
const HOME = 'firefox-container-3';

function makeArea(seed = {}) {
  const store = { ...seed };
  return {
    store,
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
  };
}

// The page listens for keys on `document`, and `document` outlives a remount:
// replacing documentElement.innerHTML leaves every earlier listener attached,
// so without this each test would run every previous test's handler too.
const keyHandlers = [];
{
  // Wrapped ONCE, here. Doing it inside mount() nests a spy on a spy on every
  // call, and a test that mounts in a loop ends up several layers deep.
  const addListener = document.addEventListener.bind(document);
  document.addEventListener = (type, fn, options) => {
    if (type === 'keydown') keyHandlers.push(fn);
    return addListener(type, fn, options);
  };
}

async function mount(url, { containers = [], firefox = true, local = {}, sync = {}, age } = {}) {
  for (const fn of keyHandlers.splice(0)) document.removeEventListener('keydown', fn);
  document.documentElement.innerHTML = HTML.replace(/<!doctype html>/i, '');
  const search =
    url === undefined
      ? ''
      : `?url=${encodeURIComponent(url)}${age === undefined ? '' : `&age=${encodeURIComponent(age)}`}`;
  // jsdom will not let location be assigned, so it is replaced outright.
  delete globalThis.location;
  globalThis.location = new URL(`https://ext/pick.html${search}`);
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `${firefox ? 'moz' : 'chrome'}-extension://linkward/${p}`,
      sendMessage: vi.fn((msg) => rulesBackend()(msg)),
    },
    storage: { sync: makeArea(sync), local: makeArea(local) },
    tabs: {
      create: vi.fn(async () => ({ id: 9 })),
      getCurrent: vi.fn(async () => ({ id: 1 })),
      remove: vi.fn(async () => {}),
    },
  };
  globalThis.browser = firefox
    ? { contextualIdentities: { query: vi.fn(async () => containers) } }
    : undefined;
  vi.resetModules();
  await import('../src/pick/pick.js');
  await settle();
}

/** The page does several awaits before it is painted. */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const $ = (id) => document.getElementById(id);
const choices = () => [...$('choices').querySelectorAll('button')];

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.browser;
  vi.restoreAllMocks();
});

describe('a hostile query string', () => {
  it('refuses anything that is not http(s), and offers no way to open it', async () => {
    // The page is web_accessible. Without this a site could link to it with
    // javascript: or file: and the picker would be the thing that opens it.
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>x', 'x']) {
      await mount(bad);
      expect($('url').textContent).toMatch(/not a link/i);
      expect($('choices').hidden).toBe(true);
    }
  });

  it('shows the address as text, never as markup', async () => {
    // A clickable link here would be a one-click open of whatever a stranger
    // put in the query string.
    await mount('https://example.com/?x=<img src=x onerror=alert(1)>');
    expect($('url').querySelector('a')).toBeNull();
    expect($('url').querySelector('img')).toBeNull();
    expect($('url').textContent).toContain('example.com');
  });

  it('copes with no url at all', async () => {
    await mount(undefined);
    expect($('choices').hidden).toBe(true);
  });
});

describe('choosing', () => {
  const two = [
    { cookieStoreId: WORK, name: 'Work', color: 'blue' },
    { cookieStoreId: HOME, name: 'Home', color: 'green' },
  ];

  it('lists the containers, with their colours', async () => {
    await mount('https://example.com/', { containers: two });
    expect(choices().map((b) => b.textContent)).toEqual(['Work', 'Home']);
    expect(choices()[0].querySelector('.dot').style.background).toBeTruthy();
  });

  it('offers the one used last first', async () => {
    // The same link from the same app usually wants the same container, and the
    // point of this page is to be quicker than doing it by hand.
    await mount('https://example.com/', {
      containers: two,
      local: { localSettings: { lastContainer: HOME } },
    });
    expect(choices().map((b) => b.textContent)).toEqual(['Home', 'Work']);
  });

  it('opens in the chosen container and tells the background it was us', async () => {
    await mount('https://example.com/doc', { containers: two });
    choices()[0].click();
    await settle();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/doc',
      active: true,
      cookieStoreId: WORK,
    });
    // Without the message the picker's own tab is intercepted straight back
    // into the picker, for ever.
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'linkward:opened',
      tabId: 9,
    });
  });

  it('opens without a container when asked to', async () => {
    await mount('https://example.com/doc', { containers: two });
    $('plain').click();
    await settle();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/doc',
      active: true,
    });
  });

  it('copies without opening anything', async () => {
    // The whole reason the button exists: sometimes the answer is "not now".
    await mount('https://example.com/doc', { containers: two });
    $('copy').click();
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://example.com/doc');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('says so when the clipboard cannot be reached', async () => {
    await mount('https://example.com/doc', { containers: two });
    navigator.clipboard.writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    $('copy').click();
    await settle();
    expect($('status').textContent).toMatch(/select the link above/i);
  });

  it('says so when the container has gone since the page loaded', async () => {
    await mount('https://example.com/doc', { containers: two });
    chrome.tabs.create = vi.fn(async () => {
      throw new Error('No cookie store exists with ID firefox-container-2');
    });
    choices()[0].click();
    await settle();
    expect($('status').hidden).toBe(false);
    expect($('status').textContent).toMatch(/Could not open it there/);
  });

  it('closes its own tab rather than leaving it behind', async () => {
    await mount('https://example.com/doc', { containers: two });
    $('cancel').click();
    await settle();
    expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
  });
});

describe('what it admits to', () => {
  it('tells a Chromium user what cannot be done, and why', async () => {
    // "Not supported yet" would be a promise. This is a wall, and the reason
    // fits in a sentence: an extension in one profile cannot see the others.
    await mount('https://example.com/', { firefox: false });
    expect($('note').hidden).toBe(false);
    expect($('note').textContent).toMatch(/seals each profile off/i);
    expect($('note').textContent).toMatch(/settled before the browser is handed it/i);
    // And it does not leave them with nothing to do about it.
    expect($('note').textContent).toMatch(/copy the link|outside the browser/i);
  });

  it('points a Firefox user at how to get containers, rather than stopping', async () => {
    // "There is nothing to choose between" is true and useless. Containers are
    // built into Firefox, but making one without Mozilla's add-on is not
    // obvious, so the page names it.
    await mount('https://example.com/', { containers: [] });
    expect($('note').textContent).toMatch(/built in, but none have been made/i);
    expect($('note').textContent).toMatch(/Multi-Account Containers/);
    // And says the two need no wiring together, which is the next question.
    expect($('note').textContent).toMatch(/no setting to connect the two/i);
  });
});

describe('the remember tick', () => {
  const two = [
    { cookieStoreId: WORK, name: 'Work', color: 'blue' },
    { cookieStoreId: HOME, name: 'Home', color: 'green' },
  ];

  it('starts unticked when nothing has been configured', async () => {
    // Ticked out of the box, one careless click silences a host for good and
    // the extension quietly stops doing what it was installed for.
    await mount('https://example.com/', { containers: two });
    expect(document.getElementById('remember').checked).toBe(false);
  });

  it('starts ticked only because the settings page says so', async () => {
    await mount('https://example.com/', {
      containers: two,
      sync: { settings: { rememberPrompt: 'ticked' } },
    });
    expect(document.getElementById('remember').checked).toBe(true);
    expect(document.getElementById('remember-row').hidden).toBe(false);
  });

  it('is not on the page at all when it has been turned off', async () => {
    // Hidden means hidden: nothing on this page can then pin a host by
    // accident, which is the point of asking for it to be gone.
    await mount('https://example.com/', {
      containers: two,
      sync: { settings: { rememberPrompt: 'hidden' } },
    });
    expect(document.getElementById('remember-row').hidden).toBe(true);
    expect(document.getElementById('remember').checked).toBe(false);
  });

  it('does not turn itself into the default for every future link', async () => {
    // It used to save itself on change, so ticking it once for ONE site quietly
    // decided what happened to every link after it, with nothing saying so.
    await mount('https://example.com/', { containers: two });
    const box = document.getElementById('remember');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle(20);
    expect(chrome.storage.sync.store.settings?.rememberPrompt).not.toBe('ticked');
  });

  it('still remembers the host it was ticked for', async () => {
    await mount('https://example.com/doc', { containers: two });
    const box = document.getElementById('remember');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    choices()[0].click();
    await settle(20);
    expect(chrome.storage.sync.store.rules['example.com']).toMatchObject({ container: 'Work' });
  });
});

describe('the words each browser gets', () => {
  it('does not offer Chromium the absence of a thing it never had', async () => {
    // "No container" is Firefox's word. On Chromium the unit is a PROFILE, and
    // no extension can open a tab in one it is not already in — so a button
    // named after containers reads as a feature that is missing.
    await mount('https://example.com/', { firefox: false });
    expect(document.getElementById('plain').textContent).toBe('Open it');
    expect(document.getElementById('title').textContent).toBe('Open this link?');
    expect(document.body.textContent).not.toMatch(/container/i);
  });

  it('keeps the container wording on Firefox, where it means something', async () => {
    await mount('https://example.com/', {
      firefox: true,
      containers: [{ cookieStoreId: WORK, name: 'Work', color: 'blue' }],
    });
    expect(document.getElementById('plain').textContent).toBe('No container');
    expect(document.getElementById('title').textContent).toBe('Where should this open?');
  });
});

describe('when the wording is decided', () => {
  it('is Chromium wording before anything is awaited, not after', async () => {
    // isFirefox() is synchronous; settings and containers are not. Deciding
    // after them paints "Where should this open?" and "No container" on a
    // Chromium screen for as long as storage takes — the very words this build
    // exists to stop showing, arriving as a flicker instead.
    document.documentElement.innerHTML = HTML.replace(/<!doctype html>/i, '');
    delete globalThis.location;
    globalThis.location = new URL(
      `https://ext/pick.html?url=${encodeURIComponent('https://a.test/')}`,
    );
    let releaseSettings;
    globalThis.chrome = {
      runtime: { getURL: (p) => `chrome-extension://linkward/${p}`, sendMessage: vi.fn() },
      storage: {
        // Never settles until the test lets it.
        sync: { get: () => new Promise((r) => (releaseSettings = r)), set: async () => {} },
        local: { get: async () => ({}), set: async () => {} },
      },
      tabs: { create: vi.fn(), getCurrent: vi.fn(async () => ({ id: 1 })), remove: vi.fn() },
    };
    globalThis.browser = undefined;
    vi.resetModules();
    const loading = import('../src/pick/pick.js');
    // Enough for the module graph to evaluate and init() to reach its first
    // await — and no further, because the settings promise above never
    // resolves. What is on screen at this point is what somebody actually sees
    // while storage is still being read. The count is generous on purpose: it
    // tracks how many modules are imported, not anything about the behaviour.
    await settle(200);

    expect(document.getElementById('plain').textContent).toBe('Open it');
    expect(document.getElementById('title').textContent).toBe('Open this link?');

    releaseSettings({});
    await loading;
  });
});

describe('the keyboard', () => {
  const three = [
    { cookieStoreId: WORK, name: 'Work', color: 'blue' },
    { cookieStoreId: HOME, name: 'Home', color: 'green' },
    { cookieStoreId: 'firefox-container-4', name: 'Admin', color: 'pink' },
  ];
  const press = (key, init = {}) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));

  it('opens the nth container with the nth digit', async () => {
    // This page interrupts something and is seen many times a day; reaching for
    // the mouse is most of what it costs.
    await mount('https://example.com/doc', { containers: three });
    press('2');
    await settle(20);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/doc',
      active: true,
      cookieStoreId: HOME,
    });
  });

  it('ignores a digit with no container behind it', async () => {
    await mount('https://example.com/doc', { containers: three });
    press('9');
    await settle(20);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('takes Enter as the one offered first', async () => {
    // Which is the container used last — the answer somebody wanted often
    // enough that it is already at the top.
    await mount('https://example.com/doc', {
      containers: three,
      local: { localSettings: { lastContainer: HOME } },
    });
    press('Enter');
    await settle(20);
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ cookieStoreId: HOME }),
    );
  });

  it('takes Enter as "open plainly" when there is nothing to choose', async () => {
    await mount('https://example.com/doc', { containers: [] });
    press('Enter');
    await settle(20);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/doc',
      active: true,
    });
  });

  it('copies on c and closes on Escape', async () => {
    await mount('https://example.com/doc', { containers: three });
    press('c');
    await settle(20);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://example.com/doc');

    press('Escape');
    await settle(20);
    expect(chrome.tabs.remove).toHaveBeenCalled();
  });

  it('keeps its hands off anything with a modifier held', async () => {
    // ⌘C belongs to whoever is trying to copy the address off the page.
    await mount('https://example.com/doc', { containers: three });
    press('c', { metaKey: true });
    press('1', { ctrlKey: true });
    press('Enter', { altKey: true });
    await settle(20);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('why the question appeared', () => {
  it('says how old the tab is, because the detection is guesswork by exclusion', async () => {
    // When it gets one wrong, the person interrupted has nothing to point at
    // and neither does anybody they report it to.
    await mount('https://example.com/', { containers: [], age: '2400' });
    expect($('why').hidden).toBe(false);
    expect($('why').textContent).toMatch(/opened 2.4s ago/);
    expect($('why').textContent).toMatch(/nothing in the browser accounts for it/i);
  });

  it('says nothing at all when it was not told', async () => {
    await mount('https://example.com/', { containers: [] });
    expect($('why').hidden).toBe(true);
  });

  it('says nothing rather than nonsense for a hostile age', async () => {
    // The query string is attacker-controlled: this page is web_accessible.
    for (const age of ['-1', 'NaN', 'Infinity', '<img>']) {
      await mount('https://example.com/', { containers: [], age });
      expect($('why').hidden).toBe(true);
    }
  });
});

describe('a key held down', () => {
  it('acts once, not once per repeat', async () => {
    // Each repeat would click the same choice again and start another open
    // before the first finished: several tabs, and the same rule written
    // several times.
    await mount('https://example.com/doc', {
      containers: [{ cookieStoreId: WORK, name: 'Work', color: 'blue' }],
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', bubbles: true, repeat: true }),
      );
    }
    await settle(30);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
  });
});
