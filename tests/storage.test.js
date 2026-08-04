import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../src/lib/storage.js';

function area() {
  const store = {};
  return {
    store,
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
  };
}

beforeEach(() => {
  globalThis.chrome = { storage: { sync: area(), local: area() } };
});

afterEach(() => {
  delete globalThis.chrome;
});

describe('settings', () => {
  it('is off until somebody turns it on', () => {
    // Switching it on is what asks for <all_urls>. An install that never does
    // must hold nothing.
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
  });

  it('fills in the defaults', async () => {
    await expect(getSettings()).resolves.toMatchObject(DEFAULT_SETTINGS);
  });

  it('never lets a non-array never-ask list reach the hot path', async () => {
    // It is JSON off disk, so it can be anything; a string here reaches a
    // .some() in the interception and throws where nothing catches it.
    await chrome.storage.sync.set({ settings: { neverAsk: 'example.com' } });
    await expect(getSettings()).resolves.toMatchObject({ neverAsk: [] });
    await chrome.storage.sync.set({ settings: { neverAsk: ['ok', 7, null] } });
    await expect(getSettings()).resolves.toMatchObject({ neverAsk: ['ok'] });
  });

  it('keeps the container id out of sync, where it would mean something else', async () => {
    await saveSettings({ enabled: true, lastContainer: 'firefox-container-2' });
    expect(chrome.storage.sync.store.settings.lastContainer).toBeUndefined();
    expect(chrome.storage.sync.store.settings.enabled).toBe(true);
    expect(chrome.storage.local.store.localSettings.lastContainer).toBe('firefox-container-2');
  });

  it('carries a pre-split value over once, then lets this machine win', async () => {
    await chrome.storage.sync.set({ settings: { lastContainer: 'firefox-container-9' } });
    await expect(getSettings()).resolves.toMatchObject({ lastContainer: 'firefox-container-9' });
    await chrome.storage.local.set({ localSettings: { lastContainer: '' } });
    await expect(getSettings()).resolves.toMatchObject({ lastContainer: '' });
  });

  it('returns what it wrote', async () => {
    await expect(saveSettings({ enabled: true })).resolves.toMatchObject({ enabled: true });
  });
});

describe('remembered per-host choices', () => {
  it('round-trips a rule, and answers {} with no storage at all', async () => {
    const { getRules, setRule } = await import('../src/lib/storage.js');
    await expect(getRules()).resolves.toEqual({});
    await setRule('example.com', 'firefox-container-2');
    await expect(getRules()).resolves.toEqual({ 'example.com': 'firefox-container-2' });

    delete globalThis.chrome;
    await expect(getRules()).resolves.toEqual({});
    await expect(setRule('x', 'y')).resolves.toBeUndefined();
  });

  it('ignores a rules blob that is not an object', async () => {
    const { getRules } = await import('../src/lib/storage.js');
    await chrome.storage.local.set({ rules: 'nonsense' });
    await expect(getRules()).resolves.toEqual({});
  });
});
