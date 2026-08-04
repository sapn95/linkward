// The decision to interrupt somebody's navigation is the whole risk of this
// extension, so this file is deliberately the largest one in the repo.
//
// Two failure modes, and they are not equal:
//   - asking when we should not → the user is interrupted on a link they clicked
//     themselves, several times a day, and uninstalls;
//   - not asking when we should → the link opens where it always used to.
// Every test below is written from that asymmetry.

import { describe, it, expect } from 'vitest';
import { isCandidateTab, shouldAsk, isInterceptable, matchesAny } from '../src/lib/candidates.js';

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
