// Remembered hosts.
//
// This is the one feature that acts WITHOUT asking, so the tests are mostly
// about when it must refuse to: a rule that cannot be resolved to a container
// on this machine has to fall back to the question. Opening the wrong identity
// silently is the failure a user of this extension cannot forgive — it is the
// exact thing they installed it to prevent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRule } from '../src/lib/containers.js';
import { getRules, setRule, setRules, removeRule, readRules } from '../src/lib/storage.js';
import { toTransfer, fromTransfer, fileName, FORMAT } from '../src/lib/transfer.js';

const WORK = { cookieStoreId: 'firefox-container-2', name: 'Work', color: 'blue' };
const HOME = { cookieStoreId: 'firefox-container-3', name: 'Home', color: 'green' };
const HERE = [WORK, HOME];

function makeArea(seed = {}) {
  const store = { ...seed };
  return {
    store,
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
  };
}

beforeEach(() => {
  globalThis.chrome = { storage: { sync: makeArea(), local: makeArea() } };
});

afterEach(() => {
  delete globalThis.chrome;
});

describe('turning a rule into a container', () => {
  it('matches on the name, so the rule survives another machine', () => {
    // The id is minted per profile. A rule synced from a laptop names an id
    // that is either absent here or, worse, belongs to a different container.
    const fromElsewhere = { container: 'Work', cookieStoreId: 'firefox-container-77' };
    expect(resolveRule(fromElsewhere, HERE)).toBe(WORK.cookieStoreId);
  });

  it('ignores case and stray spaces in the name', () => {
    expect(resolveRule({ container: '  work ' }, HERE)).toBe(WORK.cookieStoreId);
  });

  it('falls back to the id only while it still names something real', () => {
    expect(resolveRule({ container: null, cookieStoreId: HOME.cookieStoreId }, HERE)).toBe(
      HOME.cookieStoreId,
    );
    expect(
      resolveRule({ container: null, cookieStoreId: 'firefox-container-99' }, HERE),
    ).toBeUndefined();
  });

  it('never falls back to the id once a NAME has been tried and missed', () => {
    // Ids are handed out per profile and get reused. A rule for "Admin" whose
    // stored id now belongs to "Work" would open the link in Work — the wrong
    // identity, silently, which is the precise thing this extension exists to
    // prevent. A named rule that cannot be matched by name asks, full stop.
    const collided = { container: 'Admin', cookieStoreId: WORK.cookieStoreId };
    expect(resolveRule(collided, HERE)).toBeUndefined();
  });

  it('says ASK for a container that is not here, rather than guessing', () => {
    // The whole point. Anything other than undefined here means opening a
    // session in an identity the user did not choose.
    expect(resolveRule({ container: 'Admin', cookieStoreId: 'gone' }, HERE)).toBeUndefined();
    expect(resolveRule({ container: 'Work' }, [])).toBeUndefined();
    expect(resolveRule(null, HERE)).toBeUndefined();
    expect(resolveRule({}, HERE)).toBeUndefined();
  });

  it('treats "no container" as a real answer, not as a missing one', () => {
    // '' and undefined mean opposite things: one is "open it plainly", the
    // other is "ask". Conflating them would either ask forever or stop asking.
    expect(resolveRule({ plain: true, container: null }, HERE)).toBe('');
  });

  it('copes with a containers list that is not a list', () => {
    expect(resolveRule({ container: 'Work' }, null)).toBeUndefined();
    expect(resolveRule({ container: 'Work' }, 'nonsense')).toBeUndefined();
  });
});

describe('what gets stored', () => {
  it('keeps rules where the browser account can sync them', async () => {
    await setRule('Example.COM', { container: 'Work', cookieStoreId: WORK.cookieStoreId });
    expect(chrome.storage.sync.store.rules).toBeTruthy();
    // And clears the local copy an older version may have left, so a rule
    // deleted here cannot come back the next time sync reads empty.
    expect(chrome.storage.local.store.rules).toEqual({});
  });

  it('refuses rather than pretending, when there is nowhere to write', async () => {
    // Resolving quietly is how the settings page ends up announcing a change
    // over storage that was never touched.
    delete globalThis.chrome;
    await expect(setRule('a.test', { container: 'Work' })).rejects.toThrow(/no extension storage/i);
  });

  it('lower-cases the host, because a host is not case sensitive', async () => {
    await setRule('Example.COM', { container: 'Work' });
    expect(Object.keys(await getRules())).toEqual(['example.com']);
  });

  it('still reads rules a previous version left in local storage', async () => {
    // Those were bare cookieStoreIds. They mean something on this machine, and
    // dropping them would silently un-remember every host somebody had set.
    chrome.storage.local.store.rules = { 'example.com': HOME.cookieStoreId };
    const rules = await getRules();
    expect(rules['example.com']).toEqual({ container: null, cookieStoreId: HOME.cookieStoreId });
    expect(resolveRule(rules['example.com'], HERE)).toBe(HOME.cookieStoreId);
  });

  it('drops entries that name nothing at all', () => {
    expect(
      readRules({ 'a.test': '', 'b.test': null, 'c.test': {}, '': { container: 'Work' } }),
    ).toEqual({});
  });

  it('survives anything at all coming off disk', () => {
    for (const junk of [null, undefined, 'string', 42, []]) {
      expect(readRules(junk)).toEqual({});
    }
  });

  it('forgets one host without touching the others', async () => {
    await setRules({
      'a.test': { container: 'Work' },
      'b.test': { container: 'Home' },
    });
    await removeRule('a.test');
    expect(Object.keys(await getRules())).toEqual(['b.test']);
  });
});

describe('the settings file', () => {
  it('survives a round trip', () => {
    const rules = { 'example.com': { container: 'Work', cookieStoreId: WORK.cookieStoreId } };
    const out = fromTransfer(toTransfer({ neverAsk: ['a.test'], rememberPrompt: 'ticked' }, rules));
    expect(out.settings).toEqual({ neverAsk: ['a.test'], rememberPrompt: 'ticked' });
    expect(out.rules).toEqual(rules);
  });

  it('refuses a file that is not one of ours', () => {
    expect(() => fromTransfer({ settings: {} })).toThrow(/not a linkward settings file/i);
    expect(() => fromTransfer(null)).toThrow(/settings object/i);
    expect(() => fromTransfer([])).toThrow(/settings object/i);
  });

  it('refuses a file from a newer version rather than half-reading it', () => {
    expect(() => fromTransfer({ format: FORMAT, version: 99 })).toThrow(/newer version/i);
  });

  it('never imports "enabled", because a file cannot grant a permission', () => {
    // A page saying the feature is on while nothing is listening is worse than
    // one saying it is off.
    const out = fromTransfer({ format: FORMAT, version: 1, settings: { enabled: true } });
    expect(out.settings.enabled).toBeUndefined();
  });

  it('takes the default for a remember setting that is not one of the three', () => {
    // Including the boolean this used to be, in either direction, and in either
    // field: a file written by an older linkward names the old key, and one
    // hand-edited from an old example may put a boolean in the new one.
    for (const settings of [
      { rememberPrompt: 'sometimes' },
      { rememberPrompt: true },
      { rememberPrompt: false },
      { rememberChoices: true },
      { rememberChoices: false },
      {},
    ]) {
      const out = fromTransfer({ format: FORMAT, version: 1, settings });
      expect(out.settings.rememberPrompt).toBe('unticked');
      expect(out.settings.rememberChoices).toBeUndefined();
    }
  });

  it('cleans the never-ask list it is handed', () => {
    const out = fromTransfer({
      format: FORMAT,
      version: 1,
      settings: { neverAsk: ['  b.test ', 'a.test', '', 7, 'a.test'] },
    });
    expect(out.settings.neverAsk).toEqual(['a.test', 'b.test']);
  });

  it('names the file by the day it was written', () => {
    expect(fileName(Date.parse('2026-08-05T22:10:00Z'))).toBe('linkward-settings-2026-08-05.json');
  });
});

describe('a settings file that is trying something', () => {
  it('cannot replace the prototype of the map the interception reads', () => {
    // JSON.parse makes `__proto__` an OWN property, so assigning it onto an
    // ordinary object runs the setter: the rule vanishes and every lookup on
    // the returned map goes through an attacker-chosen prototype.
    const hostile = JSON.parse('{"__proto__": {"container": "Work"}, "ok.test": {"plain": true}}');
    const rules = readRules(hostile);
    expect(Object.getPrototypeOf(rules)).toBe(Object.prototype);
    expect({}.container).toBeUndefined();
    expect(rules['ok.test']).toEqual({ container: null, cookieStoreId: '', plain: true });
  });

  it('does not let an unrelated host inherit a rule', () => {
    const rules = readRules(JSON.parse('{"__proto__": {"container": "Work"}}'));
    expect(rules['never-set.test']).toBeUndefined();
  });
});
