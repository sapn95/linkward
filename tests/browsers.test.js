// The browsers a link can be handed to instead of a container.
//
// A Firefox extension cannot start another application, so this list arrives
// from a native helper over a process boundary. Every case below is a way that
// reply could put a button on the picker which cannot work — and a button that
// silently does nothing is the failure this add-on already has a catalogue
// entry about.

import { describe, it, expect } from 'vitest';
import { readBrowsers, visibleBrowsers } from '../src/lib/browsers.js';

const ok = (browsers) => ({ ok: true, browsers });
const CHROME = { id: 'com.example.chrome', name: 'Chrome', path: '/Applications/Chrome.app' };
const SAFARI = { id: 'com.example.safari', name: 'Safari', path: '/Applications/Safari.app' };

describe('reading what the helper said', () => {
  it('keeps an entry that can actually be opened', () => {
    expect(readBrowsers(ok([CHROME]))).toEqual([CHROME]);
  });

  it('drops an entry with no absolute path', () => {
    // The path is what gets handed back for the open. Without one there is
    // nothing to act on, and the button would do nothing at all.
    expect(readBrowsers(ok([{ ...CHROME, path: 'Chrome.app' }]))).toEqual([]);
    expect(readBrowsers(ok([{ ...CHROME, path: '' }]))).toEqual([]);
    expect(readBrowsers(ok([{ id: CHROME.id, name: 'Chrome' }]))).toEqual([]);
  });

  it('falls back to the id when the app named itself badly', () => {
    const [found] = readBrowsers(ok([{ ...CHROME, name: '   ' }]));
    expect(found.name).toBe('com.example.chrome');
  });

  it('keeps the first of a duplicated id', () => {
    // The same browser can sit in /Applications and ~/Applications. The helper
    // sorts by name, so the first is the one a reader would have pointed at.
    const rows = readBrowsers(ok([CHROME, { ...CHROME, name: 'Chrome (copy)' }]));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Chrome');
  });

  it('answers with nothing rather than throwing on a failed reply', () => {
    expect(readBrowsers(null)).toEqual([]);
    expect(readBrowsers({ ok: false, why: 'no such application' })).toEqual([]);
    expect(readBrowsers({ ok: true })).toEqual([]);
    expect(readBrowsers(ok('nope'))).toEqual([]);
    expect(readBrowsers(ok([null, 7, {}]))).toEqual([]);
  });
});

describe('which of them the picker shows', () => {
  const both = [CHROME, SAFARI];

  it('shows none while the feature is off', () => {
    expect(visibleBrowsers(both, { enabled: false, show: [CHROME.id] })).toEqual([]);
    expect(visibleBrowsers(both, {})).toEqual([]);
  });

  it('shows all of them when nothing has been chosen', () => {
    // Empty is not none. A fresh install has chosen nothing, and reading that
    // as "hide everything" would make the feature look broken the moment it is
    // switched on. Hiding all of them is said with enabled: false.
    expect(visibleBrowsers(both, { enabled: true })).toEqual(both);
    expect(visibleBrowsers(both, { enabled: true, show: [] })).toEqual(both);
    expect(visibleBrowsers(both, { enabled: true, show: ['  '] })).toEqual(both);
  });

  it('shows only the chosen ones', () => {
    expect(visibleBrowsers(both, { enabled: true, show: [SAFARI.id] })).toEqual([SAFARI]);
  });

  it('drops a chosen id that is no longer installed', () => {
    // A browser gets uninstalled. A list that kept naming it would offer a
    // button that cannot work.
    expect(visibleBrowsers([SAFARI], { enabled: true, show: [CHROME.id, SAFARI.id] })).toEqual([
      SAFARI,
    ]);
    expect(visibleBrowsers([], { enabled: true, show: [CHROME.id] })).toEqual([]);
  });

  it('survives junk in the stored list', () => {
    expect(visibleBrowsers(both, { enabled: true, show: 'nope' })).toEqual(both);
  });
});
