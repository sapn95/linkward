import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isContained,
  listContainers,
  containerColor,
  watchPermissions,
  hasWatchPermissions,
  requestWatchPermissions,
  DEFAULT_STORE,
} from '../src/lib/containers.js';

const WORK = 'firefox-container-2';

afterEach(() => {
  delete globalThis.browser;
  delete globalThis.chrome;
  vi.restoreAllMocks();
});

describe('isContained', () => {
  it('accepts a real container and nothing else', () => {
    expect(isContained(WORK)).toBe(true);
    expect(isContained(DEFAULT_STORE)).toBe(false);
    expect(isContained('')).toBe(false);
    expect(isContained(undefined)).toBe(false);
  });

  it('refuses a private window, whose store dies with the window', () => {
    expect(isContained('firefox-private')).toBe(false);
    expect(isContained('firefox-private-1')).toBe(false);
  });
});

describe('listContainers', () => {
  it('answers "none" without the API — that is Chrome', async () => {
    await expect(listContainers()).resolves.toEqual([]);
  });

  it('answers "none" when the user has switched containers off', async () => {
    // Firefox rejects rather than returning [], and nothing may break over a
    // feature somebody chose not to have.
    globalThis.browser = {
      contextualIdentities: {
        query: vi.fn(async () => {
          throw new Error('privacy.userContext.enabled is false');
        }),
      },
    };
    await expect(listContainers()).resolves.toEqual([]);
  });

  it('lists them, dropping the default store', async () => {
    globalThis.browser = {
      contextualIdentities: {
        query: vi.fn(async () => [
          { cookieStoreId: DEFAULT_STORE, name: 'Default' },
          { cookieStoreId: WORK, name: 'Work', color: 'blue' },
        ]),
      },
    };
    await expect(listContainers()).resolves.toEqual([
      { cookieStoreId: WORK, name: 'Work', color: 'blue' },
    ]);
  });
});

describe('containerColor', () => {
  it('paints the names Firefox uses', () => {
    expect(containerColor('blue')).toBe('#37adff');
    expect(containerColor('TOOLBAR')).toBe('currentColor');
  });

  it('gives nothing for a name it does not know', () => {
    // Firefox 153 renamed colours; insisting on knowing them all is one release
    // away from being wrong.
    expect(containerColor('chartreuse')).toBe('');
    expect(containerColor(undefined)).toBe('');
  });

  it('is not fooled by inherited property names', () => {
    expect(containerColor('constructor')).toBe('');
    expect(containerColor('__proto__')).toBe('');
  });
});

describe('watchPermissions', () => {
  it('asks for blocking webRequest on Firefox', () => {
    // Blocking is what makes "nothing was fetched" true rather than a hope.
    expect(watchPermissions(true)).toEqual({
      origins: ['<all_urls>'],
      permissions: ['webRequest', 'webRequestBlocking'],
    });
  });

  it('asks for webNavigation on Chrome, which has no blocking form', () => {
    expect(watchPermissions(false)).toEqual({
      origins: ['<all_urls>'],
      permissions: ['webNavigation'],
    });
  });

  it('reports false rather than throwing when the API is absent', async () => {
    await expect(hasWatchPermissions()).resolves.toBe(false);
    await expect(requestWatchPermissions()).resolves.toBe(false);
  });

  it('reports a refusal honestly', async () => {
    globalThis.browser = { permissions: { request: vi.fn(async () => false) } };
    await expect(requestWatchPermissions()).resolves.toBe(false);
  });
});

describe('isFirefox and handing the access back', () => {
  it('reads the build off its own extension origin, needing no permission', async () => {
    const { isFirefox } = await import('../src/lib/containers.js');
    globalThis.chrome = { runtime: { getURL: () => 'moz-extension://abc/' } };
    expect(isFirefox()).toBe(true);
    globalThis.chrome = { runtime: { getURL: () => 'chrome-extension://abc/' } };
    expect(isFirefox()).toBe(false);
    globalThis.chrome = {};
    expect(isFirefox()).toBe(false); // no runtime at all
  });

  it('asks for everything in ONE request', async () => {
    // A handler stops being user-initiated the moment it awaits, so a second
    // permissions.request always fails. One call or none.
    const request = vi.fn(async () => true);
    globalThis.chrome = { runtime: { getURL: () => 'moz-extension://a/' } };
    globalThis.browser = { permissions: { request } };
    await expect(requestWatchPermissions()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      origins: ['<all_urls>'],
      permissions: ['webRequest', 'webRequestBlocking'],
    });
  });

  it('hands the access back, and survives an API that throws', async () => {
    const { dropWatchPermissions } = await import('../src/lib/containers.js');
    globalThis.chrome = { runtime: { getURL: () => 'moz-extension://a/' } };
    const remove = vi.fn(async () => true);
    globalThis.browser = { permissions: { remove } };
    await expect(dropWatchPermissions()).resolves.toBe(true);

    globalThis.browser = {
      permissions: {
        remove: async () => {
          throw new Error('nope');
        },
        contains: async () => {
          throw new Error('nope');
        },
      },
    };
    await expect(dropWatchPermissions()).resolves.toBe(false);
    await expect(hasWatchPermissions()).resolves.toBe(false);
  });
});
