// The store scripts type into a publisher account, so the one thing they decide
// on their own — "is this tab the dashboard, and which item is it on" — is
// worth pinning down. A substring check would have said yes to all of the URLs
// below.

import { describe, it, expect } from 'vitest';
import { isDashboard, itemOf } from '../scripts/store/dashboard.mjs';

const ITEM = 'pbegofhlnmdodohhgpaalhglnjchakfb';
const REAL = `https://chrome.google.com/webstore/devconsole/af8fe239-0758-4dac-b237-c299e0e8f9b4/${ITEM}/edit`;

describe('recognising the dashboard', () => {
  it('reads the item id out of a real dashboard URL', () => {
    expect(itemOf(REAL)).toBe(ITEM);
    expect(itemOf(`${REAL}/privacy`)).toBe(ITEM);
  });

  it('is not fooled by a host that merely contains the right words', () => {
    for (const href of [
      'https://evil.test/chrome.google.com/webstore/devconsole/pub/item/edit',
      'https://chrome.google.com.evil.test/webstore/devconsole/pub/item/edit',
      'https://notchrome.google.com/webstore/devconsole/pub/item/edit',
      'https://evil.test/?next=https://chrome.google.com/webstore/devconsole/pub/item/edit',
    ]) {
      expect(itemOf(href)).toBeNull();
      expect(isDashboard(href)).toBe(false);
    }
  });

  it('says nothing for the right host on the wrong path', () => {
    expect(itemOf('https://chrome.google.com/')).toBeNull();
    expect(itemOf('https://chrome.google.com/webstore/detail/foo/bar')).toBeNull();
    expect(isDashboard('https://chrome.google.com/webstore/detail/foo/bar')).toBe(false);
  });

  it('knows the item list is still the dashboard, with no item on it', () => {
    // Otherwise a freshly opened session — which lands on the list — looks like
    // no dashboard at all, and every script refuses to start.
    for (const href of [
      'https://chrome.google.com/webstore/devconsole/',
      'https://chrome.google.com/webstore/devconsole/af8fe239-0758-4dac-b237-c299e0e8f9b4',
    ]) {
      expect(isDashboard(href)).toBe(true);
      expect(itemOf(href)).toBeNull();
    }
  });

  it('says nothing rather than throwing on something that is not a URL', () => {
    expect(itemOf('about:blank')).toBeNull();
    expect(itemOf('')).toBeNull();
  });
});
