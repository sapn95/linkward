// Fills the Chrome Web Store "Privacy practices" tab, attaching to the browser
// that `session.mjs` left open.
//
// These are the fields a reviewer actually reads, and the ones that hold a
// release back: a version that adds a permission stops publishing until that
// permission has a justification. Keeping the wording here means it is diffed
// and reviewed like anything else, instead of living in a text box.
//
// Field names come from the account's own language (German here), so the
// selectors match on the part that is stable across languages: the permission
// name itself.
import { chromium } from 'playwright-core';

const ITEM = 'pbegofhlnmdodohhgpaalhglnjchakfb';
const PRIVACY_URL = 'https://github.com/sapn95/linkward/blob/main/PRIVACY.md';

const SINGLE_PURPOSE = `linkward does one thing. When a link arrives from outside the browser — from a mail client, a chat app, a PDF viewer or the terminal — it shows the address and asks the user what should happen to it before the page is fetched: open it, copy it and open nothing, or close the tab. The user can also say "stop asking for this host".

There is no second feature. linkward injects no content script, reads no page content, contacts no server of its own, and stores nothing beyond the settings the user chose.`;

/** Keyed by the permission exactly as the manifest declares it. */
const JUSTIFICATION = {
  storage: `Holds the user's own settings and nothing else: whether the feature is switched on, the hosts they chose to stop being asked about, and the last choice they made so that it can be offered first next time. No browsing history, no page content and no identifiers are written. The data never leaves the browser.`,

  webNavigation: `webNavigation.onBeforeNavigate is the moment this extension exists for: it is the earliest point at which Chrome tells an extension that a top-level navigation is starting, and therefore the only chance to ask the user where a link should open before the page loads. Chrome MV3 removed blocking webRequest, so no earlier signal is available.

Only the URL and tab id of the navigation are read, and only for tabs the user has just opened from outside the browser. Nothing is recorded, nothing is transmitted, and no page content is accessed. The permission is optional: it is requested at runtime when the user switches the feature on, and handed back with permissions.remove when they switch it off.`,
};

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().includes('devconsole'));
if (!page) throw new Error('No dashboard tab open. Run scripts/store/session.mjs first.');

if (!page.url().includes(ITEM)) throw new Error(`Wrong item open: ${page.url()}`);
// The publisher id is part of the path and differs per account, so it is taken
// from the tab that is already on the right item rather than hard-coded.
await page.goto(page.url().replace(/\/edit(\/.*)?$/, '/edit/privacy'), {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(3500);
const step = (m) => console.log(`· ${m}`);

const areas = page.locator('textarea');
const labels = await areas.evaluateAll((els) =>
  els.map((el) => (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ')),
);

step('single purpose');
await areas.nth(0).fill(SINGLE_PURPOSE);

// Every permission the uploaded package declares gets its own box. Which boxes
// appear is decided by the zip that is currently up there, so an unknown one is
// worth stopping for: it means the manifest grew a permission nobody explained.
for (const [i, label] of labels.entries()) {
  const permission = label.match(/für (\S+)/)?.[1];
  if (!permission) continue;
  const text = JUSTIFICATION[permission];
  if (!text) {
    console.warn(`! no justification written for "${permission}" — leaving it empty`);
    continue;
  }
  step(`justification: ${permission}`);
  await areas.nth(i).fill(text);
}

step('remote code: no');
await page
  .getByText(/^Nein, ich verwende/)
  .first()
  .click();

// The three disclosures are the only checkboxes that talk about user data as
// such; the ones above them are the categories of data collected, and linkward
// collects none of them.
step('the three disclosures');
for (const box of await page.getByRole('checkbox').all()) {
  const label = (await box.getAttribute('aria-label')) ?? '';
  if (!/Nutzerdaten/.test(label)) continue;
  if (!(await box.isChecked())) await box.click();
}

step('privacy policy URL');
await page
  .getByLabel(/Datenschutzerklärung/)
  .first()
  .fill(PRIVACY_URL);

step('save');
await page.getByRole('button', { name: 'Speichern' }).first().click();
await page.waitForTimeout(5000);

await page.screenshot({ path: '/tmp/cws-after-privacy.png', fullPage: true });
console.log('done —', page.url());
await browser.close();
