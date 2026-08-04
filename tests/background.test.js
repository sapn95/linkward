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

function makeChrome({ firefox = true, granted = true, settings = { enabled: true } } = {}) {
  const sync = makeArea();
  const local = makeArea();
  sync.store.settings = settings;
  return {
    runtime: {
      getURL: (p) => `${firefox ? 'moz' : 'chrome'}-extension://linkward/${p}`,
      openOptionsPage: vi.fn(async () => {}),
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onMessage: makeEvent(),
    },
    storage: { sync, local, onChanged: makeEvent() },
    permissions: { contains: vi.fn(async () => granted), onAdded: makeEvent() },
    tabs: { onCreated: makeEvent(), onRemoved: makeEvent(), update: vi.fn(async () => ({})) },
    webRequest: { onBeforeRequest: makeEvent() },
    webNavigation: { onBeforeNavigate: makeEvent() },
  };
}

async function boot(options) {
  globalThis.chrome = makeChrome(options);
  vi.resetModules();
  await import('../src/background.js');
  // The arming is async; let it settle before anything is emitted.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return globalThis.chrome;
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
  it('registers nothing without the permissions', async () => {
    // The whole design: an install that never switches the feature on holds no
    // access and watches nothing.
    const c = await boot({ granted: false });
    expect(c.webRequest.onBeforeRequest.hasListener(() => {})).toBe(false);
    await c.tabs.onCreated.emit({ id: 7 });
    expect(await ask(c, {})).toBeUndefined(); // no listener, no answer
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
