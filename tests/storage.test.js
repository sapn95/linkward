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

  it('does not offer to silence a host until asked to', async () => {
    // On the picker this box turns a careless click into "never ask about this
    // host again" — the extension quietly stopping the one thing it was
    // installed for, with nobody having decided that.
    expect(DEFAULT_SETTINGS.rememberPrompt).toBe('unticked');
    await expect(getSettings()).resolves.toMatchObject({ rememberPrompt: 'unticked' });
  });

  it('drops the boolean this used to be, rather than reading it as a choice', async () => {
    // `true` there was written by a default that has since been reversed, so
    // for almost everybody holding it, it records nothing anyone decided.
    await chrome.storage.sync.set({ settings: { rememberChoices: true } });
    const settings = await getSettings();
    expect(settings.rememberPrompt).toBe('unticked');
    expect(settings.rememberChoices).toBeUndefined();
  });

  it('falls back to the default for a value that is not one of the three', async () => {
    await chrome.storage.sync.set({ settings: { rememberPrompt: 'sometimes' } });
    await expect(getSettings()).resolves.toMatchObject({ rememberPrompt: 'unticked' });
  });

  it('fills in the defaults', async () => {
    await expect(getSettings()).resolves.toMatchObject(DEFAULT_SETTINGS);
  });

  it('does not ask about bookmarks and typed addresses out of the box', async () => {
    // A bookmark is not a link from somewhere else — the user already said
    // where it goes by saving it. Reported twice as the picker appearing for
    // something nobody handed the browser.
    expect(DEFAULT_SETTINGS.askInternal).toBe(false);
    await expect(getSettings()).resolves.toMatchObject({ askInternal: false });
  });

  it('reads only a literal true as "ask about those too"', async () => {
    // Off disk, so it can be anything, and every truthy value here switches the
    // interception back on for every bookmark somebody has. The string "false"
    // is the one that hurts.
    for (const askInternal of ['false', 'no', 1, {}, [], 'true']) {
      await chrome.storage.sync.set({ settings: { askInternal } });
      await expect(getSettings()).resolves.toMatchObject({ askInternal: false });
    }
    await chrome.storage.sync.set({ settings: { askInternal: true } });
    await expect(getSettings()).resolves.toMatchObject({ askInternal: true });
  });

  it('writes it back as a boolean, whatever a page handed it', async () => {
    await saveSettings({ enabled: true, askInternal: 'yes' });
    expect(chrome.storage.sync.store.settings.askInternal).toBe(false);
    await saveSettings({ enabled: true, askInternal: true });
    expect(chrome.storage.sync.store.settings.askInternal).toBe(true);
  });

  it('syncs it, because it is a decision and not a machine detail', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, askInternal: true });
    expect(chrome.storage.sync.store.settings.askInternal).toBe(true);
    expect(chrome.storage.local.store.localSettings.askInternal).toBeUndefined();
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
    await setRule('example.com', { container: 'Work', cookieStoreId: 'firefox-container-2' });
    await expect(getRules()).resolves.toEqual({
      'example.com': { container: 'Work', cookieStoreId: 'firefox-container-2' },
    });

    delete globalThis.chrome;
    await expect(getRules()).resolves.toEqual({});
    await expect(setRule('x', { container: 'y' })).rejects.toThrow(/no extension storage/i);
  });

  it('ignores a rules blob that is not an object', async () => {
    const { getRules } = await import('../src/lib/storage.js');
    await chrome.storage.local.set({ rules: 'nonsense' });
    await expect(getRules()).resolves.toEqual({});
  });
});
