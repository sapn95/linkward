// Finding the dashboard tab, and saying which item it is on.
//
// Both are parsed rather than matched as substrings: `url.includes('devconsole')`
// is happy with `https://evil.test/?x=devconsole`, and while the tabs here are
// ones we opened ourselves, a check that is only accidentally right is not worth
// keeping in a script that types into a publisher account.
import { chromium } from 'playwright-core';

const HOST = 'chrome.google.com';
const PREFIX = '/webstore/devconsole/';

/** The dashboard's paths are /webstore/devconsole/<publisher>[/<item>/edit[/tab]]. */
function parse(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== HOST || !url.pathname.startsWith(PREFIX)) return null;
  const [publisher, item] = url.pathname.slice(PREFIX.length).split('/');
  return { publisher: publisher || null, item: item || null };
}

/** Any page of the developer dashboard, including the item list. */
export function isDashboard(href) {
  return parse(href) !== null;
}

/** The item a dashboard URL is on, or null — including on the list itself. */
export function itemOf(href) {
  return parse(href)?.item ?? null;
}

/**
 * The text a person would read next to each of `locator`'s elements.
 *
 * The dashboard is inconsistent about where that text lives — some fields carry
 * an aria-label, others only a `<label for>` — and a script that reads just one
 * of the two silently fills nothing. Which is exactly what it did.
 */
export function labelsOf(locator) {
  return locator.evaluateAll((els) =>
    els.map((el) => {
      const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      return (
        byFor?.innerText ||
        el.closest('label')?.innerText ||
        el.getAttribute('aria-label') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
    }),
  );
}

/**
 * Attach to the window `session.mjs` left open, on the item we expect, and
 * return its page.
 *
 * Nothing here ever calls `browser.close()`. Over CDP that shuts the whole
 * browser down — signed-in session and all — which is the opposite of the point:
 * the scripts are meant to be run one after another against the same window.
 * Letting the process exit drops the connection and leaves Chrome alone.
 */
export async function dashboard(item) {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => isDashboard(p.url()));
  if (!page) {
    throw new Error('No dashboard tab open. Run scripts/store/session.mjs first.');
  }
  // The publisher id is part of every path and differs per account, so it is
  // read off the tab that is already signed in rather than configured anywhere.
  if (item && itemOf(page.url()) !== item) {
    const { publisher } = parse(page.url());
    if (!publisher) throw new Error(`Not signed in to a publisher account: ${page.url()}`);
    await page.goto(`https://${HOST}${PREFIX}${publisher}/${item}/edit`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(4000);
  }
  return page;
}
