// The decision to interrupt somebody's navigation is the whole risk of this
// extension, so this file is deliberately the largest one in the repo.
//
// Two failure modes, and they are not equal:
//   - asking when we should not → the user is interrupted on a link they clicked
//     themselves, several times a day, and uninstalls;
//   - not asking when we should → the link opens where it always used to.
// Every test below is written from that asymmetry.

import { describe, it, expect } from 'vitest';
import {
  isCandidateTab,
  shouldAsk,
  isInterceptable,
  matchesAny,
  startedInsideBrowser,
  FOCUS_GRACE_MS,
} from '../src/lib/candidates.js';

const req = (over = {}) => ({
  type: 'main_frame',
  url: 'https://example.com/doc',
  tabId: 7,
  ...over,
});
const fresh = { candidateSince: () => 1000, now: 1200, freshMs: 5000 };

describe('isInterceptable', () => {
  it('takes ordinary web pages and nothing else', () => {
    expect(isInterceptable('https://example.com/')).toBe(true);
    expect(isInterceptable('http://example.com/')).toBe(true);
    for (const url of [
      'file:///Users/me/notes.txt',
      'moz-extension://abc/pick.html',
      'chrome-extension://abc/pick.html',
      'about:config',
      'javascript:alert(1)',
      'data:text/html,<h1>',
      'not a url',
      '',
      undefined,
    ]) {
      expect(isInterceptable(url)).toBe(false);
    }
  });
});

describe('isCandidateTab', () => {
  it('accepts a tab that appeared with no opener', () => {
    expect(isCandidateTab({ id: 1 })).toBe(true);
  });

  it('refuses a tab a page opened', () => {
    // target=_blank, window.open, a middle click — all in-browser, all not ours.
    expect(isCandidateTab({ id: 1, openerTabId: 4 })).toBe(false);
    expect(isCandidateTab({ id: 1, openerTabId: 0 })).toBe(false); // tab 0 is a tab
  });

  it('refuses a blank new tab', () => {
    // Somebody pressing Cmd+T and typing. Not a hand-off.
    for (const url of ['about:blank', 'about:newtab', 'about:home', 'chrome://newtab/']) {
      expect(isCandidateTab({ id: 1, url })).toBe(false);
    }
  });

  it('refuses a tab we opened ourselves', () => {
    // Without this the picker's own answer is intercepted straight back into
    // the picker, for ever.
    expect(isCandidateTab({ id: 1 }, { openedByUs: true })).toBe(false);
  });
});

describe('shouldAsk', () => {
  it('asks for a fresh, opener-less, document-less main frame', () => {
    expect(shouldAsk(req(), fresh)).toBe(true);
  });

  it('never asks about a subresource', () => {
    for (const type of ['sub_frame', 'image', 'script', 'xmlhttprequest', undefined]) {
      expect(shouldAsk(req({ type }), fresh)).toBe(false);
    }
  });

  it('never asks about a navigation a page started', () => {
    // This is the single most important exclusion: it is what keeps an ordinary
    // click on a link from being interrupted.
    expect(shouldAsk(req({ originUrl: 'https://news.example/' }), fresh)).toBe(false);
    expect(shouldAsk(req({ documentUrl: 'https://news.example/' }), fresh)).toBe(false);
  });

  it('never asks about a tab it did not flag', () => {
    expect(shouldAsk(req(), { ...fresh, candidateSince: () => undefined })).toBe(false);
  });

  it('never asks again once the tab has been used for a while', () => {
    // Only the FIRST navigation after a tab appears can be the one it was
    // created for. Everything after is the user browsing.
    expect(shouldAsk(req(), { ...fresh, now: 1000 + 5001 })).toBe(false);
    expect(shouldAsk(req(), { ...fresh, now: 1000 + 4999 })).toBe(true);
  });

  it('never asks about a host on the never-ask list', () => {
    expect(shouldAsk(req(), { ...fresh, isExcluded: () => true })).toBe(false);
  });

  it('never asks about a URL it could not open anyway', () => {
    expect(shouldAsk(req({ url: 'about:config' }), fresh)).toBe(false);
  });

  it('survives junk without throwing', () => {
    expect(() => shouldAsk(undefined, fresh)).not.toThrow();
    expect(shouldAsk(undefined, fresh)).toBe(false);
    expect(shouldAsk(req(), {})).toBe(false); // no candidateSince at all
  });
});

describe('matchesAny', () => {
  it('matches the host and its subdomains', () => {
    expect(matchesAny('https://example.com/x', ['example.com'])).toBe(true);
    expect(matchesAny('https://mail.example.com/x', ['example.com'])).toBe(true);
    expect(matchesAny('https://EXAMPLE.com/x', ['Example.COM'])).toBe(true);
    expect(matchesAny('https://example.com/x', ['*.example.com'])).toBe(true);
  });

  it('does not match a host that merely ends in the same letters', () => {
    // notexample.com must not be caught by example.com.
    expect(matchesAny('https://notexample.com/', ['example.com'])).toBe(false);
    expect(matchesAny('https://example.com.evil.test/', ['example.com'])).toBe(false);
  });

  it('ignores blanks and junk rather than matching everything', () => {
    // An empty line in the textarea must not silently disable the extension.
    expect(matchesAny('https://example.com/', ['', '   ', null, undefined])).toBe(false);
    expect(matchesAny('https://example.com/', undefined)).toBe(false);
    expect(matchesAny('not a url', ['example.com'])).toBe(false);
  });
});

describe('a tab the browser opened for itself', () => {
  // Every browser names its own pages differently, and a new tab is where
  // somebody types a search. Interrupting THAT is the failure that gets an
  // add-on uninstalled — it was reported from Vivaldi, whose start page was
  // not on the four-name list this replaced.
  const OWN_PAGES = [
    'about:blank',
    'about:newtab',
    'about:home',
    'chrome://newtab/',
    'chrome://vivaldi-webui/startpage',
    'vivaldi://startpage',
    'edge://newtab/',
    'opera://startpage',
    'about:sessionrestore',
    'moz-extension://abc/newtab.html',
  ];

  it.each(OWN_PAGES)('is not a candidate: %s', (url) => {
    expect(isCandidateTab({ id: 1, url })).toBe(false);
  });

  it('is still a candidate when it starts on a real address', () => {
    // That is what being handed a link looks like.
    expect(isCandidateTab({ id: 1, url: 'https://example.com/doc' })).toBe(true);
    expect(isCandidateTab({ id: 1, url: 'http://intranet.local/' })).toBe(true);
  });

  it('reads pendingUrl too, which is where Chrome puts it', () => {
    expect(isCandidateTab({ id: 1, url: '', pendingUrl: 'chrome://newtab/' })).toBe(false);
    expect(isCandidateTab({ id: 1, url: '', pendingUrl: 'https://example.com/' })).toBe(true);
  });

  it('stays a candidate when the browser has not said yet', () => {
    // Empty means unknown, not empty. Refusing here would stop the extension
    // asking at all on a browser that fills the URL in later.
    expect(isCandidateTab({ id: 1 })).toBe(true);
    expect(isCandidateTab({ id: 1, url: '' })).toBe(true);
  });
});

describe('startedInsideBrowser', () => {
  // The one rule that separates a bookmark from a hand-off. Everything else in
  // this file sees them as the same event, because to the browser they are.
  //
  // The asymmetry from the top of the file applies here in full: `true` means
  // "leave this alone", so a wrong `true` is a link from Slack that opened
  // wherever it liked. Every case below that is not POSITIVE evidence of
  // somebody clicking inside the browser has to come back false.
  const IN_FRONT_FOR_AGES = { focusedSince: 1000 };

  it('says yes when the browser had been in front for a while', () => {
    // A bookmark, an address typed into a new tab, a search: the user was
    // already here.
    expect(startedInsideBrowser(IN_FRONT_FOR_AGES, { at: 1000 + FOCUS_GRACE_MS + 1 })).toBe(true);
    expect(startedInsideBrowser(IN_FRONT_FOR_AGES, { at: 60_000 })).toBe(true);
  });

  it('says no while the browser has only just come to the front', () => {
    // Which is what being handed a link looks like: the OS raises the browser
    // and the tab arrives in the same breath.
    expect(startedInsideBrowser(IN_FRONT_FOR_AGES, { at: 1000 })).toBe(false);
    expect(startedInsideBrowser(IN_FRONT_FOR_AGES, { at: 1000 + FOCUS_GRACE_MS })).toBe(false);
  });

  it('is exact at the boundary, in the direction that asks', () => {
    // Strictly greater. At exactly the grace period it still asks, because the
    // cost of asking once too often is an interruption and the cost of not
    // asking is a session in the wrong container.
    expect(startedInsideBrowser({ focusedSince: 0 }, { at: FOCUS_GRACE_MS })).toBe(false);
    expect(startedInsideBrowser({ focusedSince: 0 }, { at: FOCUS_GRACE_MS + 1 })).toBe(true);
  });

  it('says no when the focus change landed after the tab did', () => {
    // The ordinary race on a hand-off: nothing orders windows.onFocusChanged
    // against tabs.onCreated, and on a warm browser they arrive together. A
    // negative age must not read as "in front for ages".
    expect(startedInsideBrowser({ focusedSince: 5000 }, { at: 4000 })).toBe(false);
    expect(startedInsideBrowser({ focusedSince: 5000 }, { at: 0 })).toBe(false);
  });

  it('says no when the browser is not in front at all', () => {
    // A link that arrived without raising the browser — `open -g`, a script.
    // Not somebody clicking in here, so not ours to skip.
    expect(startedInsideBrowser({ focusedSince: null }, { at: 60_000 })).toBe(false);
  });

  it('says no when nothing has been recorded', () => {
    // The state is lost with the event page and lives in storage.session, which
    // can be unavailable. "We do not know" must behave exactly like linkward
    // did before this rule existed.
    expect(startedInsideBrowser({}, { at: 60_000 })).toBe(false);
    expect(startedInsideBrowser(undefined, { at: 60_000 })).toBe(false);
    expect(startedInsideBrowser(null, { at: 60_000 })).toBe(false);
  });

  it('says no for anything that is not a real timestamp', () => {
    // storage.session is storage: it can hold whatever a previous version, or a
    // bug, put there. NaN in particular compares false against everything,
    // which happens to be the safe answer — but not by design, so it is pinned.
    for (const focusedSince of [NaN, Infinity, -Infinity, '1000', true, {}, [], () => 1]) {
      expect(startedInsideBrowser({ focusedSince }, { at: 60_000 })).toBe(false);
    }
  });

  it('takes the grace period as an argument rather than reaching for a global', () => {
    expect(startedInsideBrowser({ focusedSince: 0 }, { at: 100, graceMs: 50 })).toBe(true);
    expect(startedInsideBrowser({ focusedSince: 0 }, { at: 100, graceMs: 500 })).toBe(false);
  });

  it('defaults `at` to now, so a missing creation time is not a free pass', () => {
    // If the caller has no timestamp for the tab, the answer must still be the
    // conservative one for anything the browser has just been given.
    expect(startedInsideBrowser({ focusedSince: Date.now() })).toBe(false);
    expect(startedInsideBrowser({ focusedSince: Date.now() - 60_000 })).toBe(true);
  });

  it('leaves a full second and a half of room for a slow hand-off', () => {
    // A browser that had to start takes a few hundred milliseconds between
    // being raised and producing the tab. Shrinking this constant is how that
    // case silently stops being asked about.
    expect(FOCUS_GRACE_MS).toBeGreaterThanOrEqual(1000);
  });
});
