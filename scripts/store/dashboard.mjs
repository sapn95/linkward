// Finding the dashboard tab, and saying which item it is on.
//
// Both are parsed rather than matched as substrings: `url.includes('devconsole')`
// is happy with `https://evil.test/?x=devconsole`, and while the tabs here are
// ones we opened ourselves, a check that is only accidentally right is not worth
// keeping in a script that types into a publisher account.
import { chromium } from 'playwright-core';

const HOST = 'chrome.google.com';
const PREFIX = '/webstore/devconsole/';

/** The dashboard's paths are /webstore/devconsole/<publisher>/<item>/edit[/tab]. */
export function itemOf(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== HOST || !url.pathname.startsWith(PREFIX)) return null;
  return url.pathname.slice(PREFIX.length).split('/')[1] ?? null;
}

/** Attach to the window `session.mjs` left open, on the item we expect. */
export async function dashboard(item) {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => itemOf(p.url()) !== null);
  if (!page) {
    await browser.close();
    throw new Error('No dashboard tab open. Run scripts/store/session.mjs first.');
  }
  if (item && itemOf(page.url()) !== item) {
    const wrong = page.url();
    await browser.close();
    throw new Error(`Wrong item open: ${wrong}`);
  }
  return { browser, page };
}
