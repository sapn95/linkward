// @vitest-environment jsdom
//
// The interception, driven end to end against a fake browser. What is under
// test is not "does it redirect" but "does it leave people alone": every case
// where linkward must NOT interrupt is worth more here than the happy path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeEvent() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    hasListener: (fn) => fns.includes(fn),
    /** How many listeners are on it — "any at all" is the question that matters. */
    size: () => fns.length,
    /** Synchronous, for onMessage: the reply comes through sendResponse. */
    emitSync: (...args) => fns.map((fn) => fn(...args)),
    emit: async (...args) => {
      const out = [];
      for (const fn of fns) out.push(await fn(...args));
      return out;
    },
  };
}

function makeArea() {
  const store = {};
  return {
    store,
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
  };
}

/**
 * A browser, faked as closely as the real ones behave — including the part that
 * matters most here: an OPTIONAL permission that has not been granted means the
 * namespace is not there AT ALL. `chrome.webRequest` is undefined, not an empty
 * object. Modelling it as always-present is what let a whole class of arming
 * bug through: the tests could not tell "registered" from "could not register".
 */
function makeChrome({ firefox = true, granted = true, settings = { enabled: true } } = {}) {
  const sync = makeArea();
  const local = makeArea();
  sync.store.settings = settings;
  const c = {
    runtime: {
      getURL: (p) => `${firefox ? 'moz' : 'chrome'}-extension://linkward/${p}`,
      openOptionsPage: vi.fn(async () => {}),
      // Real one rejects when the tab cannot be made.
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onMessage: makeEvent(),
    },
    action: { onClicked: makeEvent() },
    storage: { sync, local, onChanged: makeEvent() },
    permissions: { contains: vi.fn(async () => granted), onAdded: makeEvent() },
    tabs: {
      onCreated: makeEvent(),
      onRemoved: makeEvent(),
      create: vi.fn(async () => ({ id: 42 })),
      remove: vi.fn(async () => {}),
      update: vi.fn(async () => ({})),
    },
  };
  if (granted) {
    if (firefox) c.webRequest = { onBeforeRequest: makeEvent() };
    else c.webNavigation = { onBeforeNavigate: makeEvent() };
  }
  return c;
}

async function boot(options) {
  globalThis.chrome = makeChrome(options);
  vi.resetModules();
  await import('../src/background.js');
  await settle();
  return globalThis.chrome;
}

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** What a Firefox blocking listener answered for one request. */
async function ask(c, details) {
  const [answer] = await c.webRequest.onBeforeRequest.emit({
    type: 'main_frame',
    url: 'https://example.com/doc',
    tabId: 7,
    ...details,
  });
  return answer;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.chrome;
  delete globalThis.browser;
});

describe('arming', () => {
  it('registers nothing when the browser has not granted the permission', async () => {
    // Without it there is no chrome.webRequest to add to. The extension must
    // come up anyway rather than throwing on load — a background page that
    // dies at import takes every other listener with it.
    const c = await boot({ granted: false });
    expect(c.webRequest).toBeUndefined();
    await c.tabs.onCreated.emit({ id: 7 });
  });

  it('registers WITHOUT waiting for anything, or the event page can never wake', async () => {
    // The MV3 background is an event page: the browser only restarts it for
    // listeners added on the first, synchronous run. One added after an await —
    // on a permission check, say — is invisible to that machinery, so the
    // moment the page idles out every link opens straight through, silently.
    //
    // The permission check here NEVER settles. Any implementation that waits
    // for one registers nothing, which is exactly the bug this pins down.
    const c = makeChrome({ granted: true });
    c.permissions.contains = () => new Promise(() => {});
    globalThis.chrome = c;
    vi.resetModules();
    await import('../src/background.js');
    await settle();
    expect(c.webRequest.onBeforeRequest.size()).toBe(1);
  });

  it('does the same on Chrome, where the worker is stopped even more eagerly', async () => {
    const c = makeChrome({ firefox: false, granted: true });
    c.permissions.contains = () => new Promise(() => {});
    globalThis.chrome = c;
    vi.resetModules();
    await import('../src/background.js');
    await settle();
    expect(c.webNavigation.onBeforeNavigate.size()).toBe(1);
  });

  it('arms as soon as the permission arrives, without a restart', async () => {
    // The order a real install goes in: load with nothing, then the user ticks
    // the box. Nothing reloads the background page at that point.
    const c = await boot({ granted: false });
    c.webRequest = { onBeforeRequest: makeEvent() };
    await c.permissions.onAdded.emit({ origins: ['<all_urls>'] });
    await settle();
    expect(c.webRequest.onBeforeRequest.size()).toBe(1);
  });

  it('does not register the same listener twice', async () => {
    // arm() runs on load, on install, on startup and on every permission
    // change. Two listeners would answer the same blocking request twice.
    const c = await boot();
    await c.runtime.onInstalled.emit({ reason: 'update' });
    await c.runtime.onStartup.emit();
    await c.permissions.onAdded.emit({});
    await settle();
    expect(c.webRequest.onBeforeRequest.size()).toBe(1);
  });

  it('uses blocking webRequest on Firefox and webNavigation on Chrome', async () => {
    const ff = await boot({ firefox: true });
    await ff.tabs.onCreated.emit({ id: 7 });
    expect(await ask(ff, {})).toEqual({
      redirectUrl: expect.stringContaining('moz-extension://linkward/pick/pick.html'),
    });

    const cr = await boot({ firefox: false });
    await cr.tabs.onCreated.emit({ id: 7 });
    await cr.webNavigation.onBeforeNavigate.emit({
      frameId: 0,
      tabId: 7,
      url: 'https://example.com/doc',
    });
    expect(cr.tabs.update).toHaveBeenCalledWith(7, {
      url: expect.stringContaining('chrome-extension://linkward/pick/pick.html'),
    });
  });
});

describe('when it must leave you alone', () => {
  it('does nothing while the feature is off', async () => {
    const c = await boot({ settings: { enabled: false } });
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, {})).toEqual({});
  });

  it('does nothing for a link clicked on a page', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, { originUrl: 'https://news.example/' })).toEqual({});
  });

  it('does nothing for a tab a page opened', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7, openerTabId: 3 });
    expect(await ask(c, {})).toEqual({});
  });

  it('does nothing for a host on the never-ask list', async () => {
    const c = await boot({ settings: { enabled: true, neverAsk: ['example.com'] } });
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, {})).toEqual({});
  });

  it('asks once per tab, not for everything the user then browses to', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, {})).toHaveProperty('redirectUrl');
    // Second navigation in the same tab: the user is browsing now.
    expect(await ask(c, { url: 'https://elsewhere.example/' })).toEqual({});
  });

  it('forgets a tab that closed, so its id cannot be reused into a prompt', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7 });
    await c.tabs.onRemoved.emit(7);
    expect(await ask(c, {})).toEqual({});
  });

  it('does not intercept the tab the picker itself opened', async () => {
    // Otherwise the answer is intercepted straight back into the question.
    const c = await boot();
    await c.runtime.onMessage.emit({ type: 'linkward:opened', tabId: 7 });
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, {})).toEqual({});
  });
});

describe('what it hands to the picker', () => {
  it('passes the URL as a parameter, not as a path', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7 });
    const { redirectUrl } = await ask(c, { url: 'https://example.com/a?b=1#c' });
    expect(new URL(redirectUrl).searchParams.get('url')).toBe('https://example.com/a?b=1#c');
  });
});

describe('the first thing it does after being installed', () => {
  it('opens its own settings page, because nothing works until someone does', async () => {
    // Every permission this needs is granted on a click, so a fresh install is
    // inert. A link opening exactly as it always did reads as broken, and
    // nobody goes hunting for the settings of an extension that has never
    // visibly done anything.
    const c = await boot();
    await c.runtime.onInstalled.emit({ reason: 'install' });
    expect(c.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it('does not reopen it on an update or a browser restart', async () => {
    // Reopening a settings tab behind someone's back on every auto-update is
    // how an extension gets uninstalled.
    const c = await boot();
    await c.runtime.onInstalled.emit({ reason: 'update' });
    await c.runtime.onStartup.emit();
    expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
  });

  it('still arms the listener when it was an update', async () => {
    const c = await boot({ settings: { enabled: true } });
    await c.runtime.onInstalled.emit({ reason: 'update' });
    expect(c.webRequest.onBeforeRequest.hasListener).toBeTruthy();
    await c.tabs.onCreated.emit({ id: 7 });
    const answer = await ask(c, {});
    expect(answer.redirectUrl).toContain('pick/pick.html');
  });
});

describe('a host the user already answered for', () => {
  const WORK = 'firefox-container-2';

  async function withRule(rule, containers = [{ cookieStoreId: WORK, name: 'Work' }]) {
    const c = await boot({ settings: { enabled: true } });
    c.storage.sync.store.rules = { 'example.com': rule };
    globalThis.browser = { contextualIdentities: { query: async () => containers } };
    c.tabs.create = vi.fn(async () => ({ id: 42 }));
    c.tabs.remove = vi.fn(async () => {});
    return c;
  }

  it('opens it in the remembered container without asking again', async () => {
    // Until now this was a promise the tick box made and nothing kept: the rule
    // was written and never read back.
    const c = await withRule({ container: 'Work', cookieStoreId: WORK });
    await c.tabs.onCreated.emit({ id: 7 });
    const answer = await ask(c, {});
    // Cancelled, not redirected: a redirect cannot move a tab into another
    // cookie store, so the page would load in the wrong one first.
    expect(answer).toEqual({ cancel: true });
    await settle(20);
    expect(c.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/doc',
      active: true,
      cookieStoreId: WORK,
    });
    expect(c.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('does not intercept the tab it just opened itself', async () => {
    // The new tab has no opener, exactly like an external one. Without the
    // claim staked before tabs.create resolves, linkward asks about its own
    // answer, opens another tab, and does it again.
    const c = await withRule({ container: 'Work', cookieStoreId: WORK });
    await c.tabs.onCreated.emit({ id: 7 });
    await ask(c, {});
    await Promise.resolve();
    await c.tabs.onCreated.emit({ id: 42 });
    expect(await ask(c, { tabId: 42 })).toEqual({});
  });

  it('lets the request run when the answer was "no container"', async () => {
    // '' is an answer, not a missing one. Cancelling and reopening here would
    // be a pointless round trip through a new tab.
    const c = await withRule({ container: null, cookieStoreId: '', plain: true });
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, {})).toEqual({});
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('asks again when the container the rule names is gone', async () => {
    // Renamed, deleted, or a rule synced from another machine. Opening some
    // other container instead is the one thing this extension must never do.
    const c = await withRule({ container: 'Admin', cookieStoreId: 'firefox-container-9' });
    await c.tabs.onCreated.emit({ id: 7 });
    const answer = await ask(c, {});
    expect(answer.redirectUrl).toContain('pick/pick.html');
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('does not apply one host’s rule to another host', async () => {
    const c = await withRule({ container: 'Work', cookieStoreId: WORK });
    await c.tabs.onCreated.emit({ id: 7 });
    const answer = await ask(c, { url: 'https://elsewhere.example/x' });
    expect(answer.redirectUrl).toContain('pick/pick.html');
  });
});

describe('the same, on Chrome', () => {
  /** Chrome answers by turning the tab around; there is nothing to cancel. */
  async function navigate(c, url = 'https://example.com/doc', tabId = 7) {
    await c.webNavigation.onBeforeNavigate.emit({ frameId: 0, tabId, url });
    await settle();
  }

  it('never opens a container, because Chrome has none to open', async () => {
    // A rule synced from Firefox names a container this browser cannot produce.
    // Acting on it half way — opening the link plainly and calling it done —
    // would put a work session in a personal profile without a word.
    const c = await boot({ firefox: false, settings: { enabled: true } });
    c.storage.sync.store.rules = {
      'example.com': { container: 'Work', cookieStoreId: 'firefox-container-2' },
    };
    await c.tabs.onCreated.emit({ id: 7 });
    await navigate(c);
    expect(c.tabs.create).not.toHaveBeenCalled();
    expect(c.tabs.update).toHaveBeenCalledWith(7, {
      url: expect.stringContaining('pick/pick.html'),
    });
  });

  it('honours "no container", which is the one rule Chrome can keep', async () => {
    const c = await boot({ firefox: false, settings: { enabled: true } });
    c.storage.sync.store.rules = {
      'example.com': { container: null, cookieStoreId: '', plain: true },
    };
    await c.tabs.onCreated.emit({ id: 7 });
    await navigate(c);
    // Left alone: the navigation Chrome already started IS the answer.
    expect(c.tabs.update).not.toHaveBeenCalled();
    expect(c.tabs.create).not.toHaveBeenCalled();
  });

  it('ignores a sub-frame, which is not a link anybody handed the browser', async () => {
    const c = await boot({ firefox: false, settings: { enabled: true } });
    await c.tabs.onCreated.emit({ id: 7 });
    await c.webNavigation.onBeforeNavigate.emit({
      frameId: 3,
      tabId: 7,
      url: 'https://ads.example/frame',
    });
    await settle();
    expect(c.tabs.update).not.toHaveBeenCalled();
  });

  it('leaves the never-ask list alone on Chrome too', async () => {
    const c = await boot({
      firefox: false,
      settings: { enabled: true, neverAsk: ['example.com'] },
    });
    await c.tabs.onCreated.emit({ id: 7 });
    await navigate(c);
    expect(c.tabs.update).not.toHaveBeenCalled();
  });

  it('asks once per tab on Chrome as well', async () => {
    const c = await boot({ firefox: false, settings: { enabled: true } });
    await c.tabs.onCreated.emit({ id: 7 });
    await navigate(c);
    expect(c.tabs.update).toHaveBeenCalledTimes(1);
    await navigate(c, 'https://elsewhere.example/');
    expect(c.tabs.update).toHaveBeenCalledTimes(1);
  });
});

describe('the two failures that leave somebody with the wrong window', () => {
  const WORK = 'firefox-container-2';

  it('does not put a picker on top of a page that opened perfectly well', async () => {
    // Closing the old tab is tidying up. If it fails — and it does, when the
    // tab is already gone — the link is STILL open in the right container, and
    // reaching for the picker at that point hands the user two tabs and a
    // question they already answered.
    const c = await boot({ settings: { enabled: true } });
    c.storage.sync.store.rules = { 'example.com': { container: 'Work', cookieStoreId: WORK } };
    globalThis.browser = {
      contextualIdentities: { query: async () => [{ cookieStoreId: WORK, name: 'Work' }] },
    };
    c.tabs.remove = vi.fn(async () => {
      throw new Error('No tab with id 7');
    });
    await c.tabs.onCreated.emit({ id: 7 });
    await ask(c, {});
    await settle(20);
    expect(c.tabs.create).toHaveBeenCalled();
    expect(c.tabs.update).not.toHaveBeenCalled();
  });

  it('un-flags the tab the picker opened, not just marks it as ours', async () => {
    // tabs.onCreated fires first and flags the new tab a candidate; the
    // picker's message arrives after. `ours` is only read at creation time, so
    // marking it there and then is too late — the flag is what the
    // interception reads, and it has to go.
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 9 });
    await c.runtime.onMessage.emit({ type: 'linkward:opened', tabId: 9 });
    expect(await ask(c, { tabId: 9 })).toEqual({});
  });
});

describe('opening in a remembered container, when it goes wrong', () => {
  const WORK = 'firefox-container-2';

  async function pinned(create) {
    const c = await boot({ settings: { enabled: true } });
    c.storage.sync.store.rules = { 'example.com': { container: 'Work', cookieStoreId: WORK } };
    globalThis.browser = {
      contextualIdentities: { query: async () => [{ cookieStoreId: WORK, name: 'Work' }] },
    };
    c.tabs.create = create;
    return c;
  }

  it('falls back to the picker when the container went in the meantime', async () => {
    // Deleted between resolving the rule and acting on it. The original request
    // is already cancelled, so doing nothing leaves a blank tab and no reason.
    const c = await pinned(
      vi.fn(async () => {
        throw new Error('No cookie store exists with ID firefox-container-2');
      }),
    );
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, {})).toEqual({ cancel: true });
    await settle(20);
    expect(c.tabs.update).toHaveBeenCalledWith(7, {
      url: expect.stringContaining('pick/pick.html'),
    });
  });

  it('claims the new tab even when it appears before create has returned', async () => {
    // The ordinary case in Firefox: onCreated fires first. Without the claim
    // staked up front, the tab is flagged a candidate and linkward asks about
    // the answer it just gave.
    const c = await pinned(
      vi.fn(async ({ url }) => {
        await c.tabs.onCreated.emit({ id: 42, url });
        return { id: 42 };
      }),
    );
    await c.tabs.onCreated.emit({ id: 7 });
    await ask(c, {});
    await settle(20);
    expect(await ask(c, { tabId: 42 })).toEqual({});
  });

  it('does not let a spent claim swallow the next external link', async () => {
    // The claim is dropped once the id is known, and it only ever matched the
    // address we opened. Left standing, the very next tab from another
    // application would be taken for one of ours and never asked about.
    const c = await pinned(vi.fn(async () => ({ id: 42 })));
    await c.tabs.onCreated.emit({ id: 7 });
    await ask(c, {});
    await settle(20);
    await c.tabs.onCreated.emit({ id: 99, url: 'https://elsewhere.example/' });
    const answer = await ask(c, { tabId: 99, url: 'https://elsewhere.example/' });
    expect(answer.redirectUrl).toContain('pick/pick.html');
  });
});

describe('two remembered links arriving at once', () => {
  const WORK = 'firefox-container-2';

  it('does not let one opening cancel the other, or swallow a third link', async () => {
    // Both stake a claim before tabs.create resolves. A shared counter got both
    // halves wrong: the first to finish cancelled the second's claim, and while
    // either was in flight ANY new tab was taken for ours — including a link
    // somebody had just clicked in another application.
    const c = await boot({ settings: { enabled: true } });
    c.storage.sync.store.rules = {
      'example.com': { container: 'Work', cookieStoreId: WORK },
      'other.example': { container: 'Work', cookieStoreId: WORK },
    };
    globalThis.browser = {
      contextualIdentities: { query: async () => [{ cookieStoreId: WORK, name: 'Work' }] },
    };
    const held = [];
    let next = 100;
    c.tabs.create = vi.fn(
      ({ url }) => new Promise((resolve) => held.push({ url, go: () => resolve({ id: next++ }) })),
    );

    await c.tabs.onCreated.emit({ id: 7 });
    await ask(c, { tabId: 7 });
    await c.tabs.onCreated.emit({ id: 8 });
    await ask(c, { tabId: 8, url: 'https://other.example/x' });
    await settle();
    expect(held).toHaveLength(2);

    // A third tab, from another application, while both are still in flight.
    // It is nothing to do with either address, so it must still be asked about.
    await c.tabs.onCreated.emit({ id: 50, url: 'https://stranger.example/' });
    const stranger = await ask(c, { tabId: 50, url: 'https://stranger.example/' });
    expect(stranger.redirectUrl).toContain('pick/pick.html');

    // The first finishes; the second's claim must survive it.
    held[0].go();
    await settle(20);
    await c.tabs.onCreated.emit({ id: 101, url: held[1].url });
    held[1].go();
    await settle(20);
    expect(await ask(c, { tabId: 101, url: held[1].url })).toEqual({});
  });
});

describe('two pages changing the remembered hosts at once', () => {
  /** What a page sends; the background is the only thing that writes. */
  const ask = (c, msg) =>
    new Promise((resolve) => {
      const [answer] = c.runtime.onMessage.emitSync(msg, {}, resolve);
      return answer;
    });

  it('does not lose a host when the picker and the settings page overlap', async () => {
    // Every change is read-modify-write over one object. Without a single
    // writer, the later write lands on a map read before the earlier one, and
    // a host somebody pinned a second ago is gone — silently, which is the
    // worst way for this particular thing to fail.
    const c = await boot();
    await Promise.all([
      ask(c, { type: 'linkward:rules:set', host: 'a.test', rule: { container: 'Work' } }),
      ask(c, { type: 'linkward:rules:set', host: 'b.test', rule: { container: 'Home' } }),
      ask(c, { type: 'linkward:rules:set', host: 'c.test', rule: { container: 'Work' } }),
    ]);
    expect(Object.keys(c.storage.sync.store.rules).sort()).toEqual(['a.test', 'b.test', 'c.test']);
  });

  it('keeps serving the next write after one of them fails', async () => {
    // A rejection left on the chain would make every later write reject with
    // somebody else's error, which is a worse bug than the one being fixed.
    const c = await boot();
    const real = c.storage.sync.set;
    let first = true;
    c.storage.sync.set = async (o) => {
      if (first) {
        first = false;
        throw new Error('quota exceeded');
      }
      return real(o);
    };
    const failed = await ask(c, {
      type: 'linkward:rules:set',
      host: 'a.test',
      rule: { container: 'Work' },
    });
    expect(failed.error).toMatch(/quota exceeded/);
    const ok = await ask(c, {
      type: 'linkward:rules:set',
      host: 'b.test',
      rule: { container: 'Home' },
    });
    expect(ok.error).toBeUndefined();
    expect(Object.keys(ok.rules)).toEqual(['b.test']);
  });

  it('tells the page the reason instead of answering nothing', async () => {
    // Without keeping the message channel open the caller gets undefined and
    // reports success over a write that may never have happened.
    const c = await boot();
    const answer = await ask(c, { type: 'linkward:rules:set', host: '', rule: null });
    expect(answer).toBeDefined();
  });

  it('leaves messages that are not about rules to the other listener', async () => {
    const c = await boot();
    await c.runtime.onMessage.emit({ type: 'linkward:opened', tabId: 7 });
    expect(c.storage.sync.store.rules).toBeUndefined();
  });
});

describe('typing in the address bar', () => {
  it('is not interrupted, whatever the browser calls its own new tab', async () => {
    // Reported from Vivaldi: open a tab, type a search, and linkward asked
    // where "it" should open. The tab was a candidate because Vivaldi's start
    // page was not on a hard-coded list of four names.
    for (const url of ['chrome://vivaldi-webui/startpage', 'about:newtab', 'edge://newtab/']) {
      const c = await boot();
      await c.tabs.onCreated.emit({ id: 7, url });
      expect(await ask(c, { url: 'https://duckduckgo.com/?q=linkward' })).toEqual({});
    }
  });

  it('still asks about a tab that arrived carrying a link', async () => {
    const c = await boot();
    await c.tabs.onCreated.emit({ id: 7, url: 'https://example.com/doc' });
    const answer = await ask(c, {});
    expect(answer.redirectUrl).toContain('pick/pick.html');
  });
});

describe('the toolbar button', () => {
  it('opens the settings in a tab, not in a popup', async () => {
    // A popup is a few hundred pixels wide. This page has a list of remembered
    // hosts, a dropdown, a textarea and an import/export row, and in a popup
    // every one of them folds into a column too narrow to read.
    const c = await boot();
    await c.action.onClicked.emit({ id: 1 });
    expect(c.runtime.openOptionsPage).toHaveBeenCalled();
  });
});

describe('when the settings page will not open', () => {
  it('does not leave an unhandled rejection behind', async () => {
    // An onClicked listener's promise is dropped by the dispatcher, so nothing
    // downstream can catch this. In an event page it is noise nobody sees and
    // a wake-up nobody asked for.
    const c = await boot();
    c.runtime.openOptionsPage = vi.fn(async () => {
      throw new Error('No tab could be created');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await c.action.onClicked.emit({ id: 1 });
    await settle(20);
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
