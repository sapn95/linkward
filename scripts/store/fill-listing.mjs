// Fills the Chrome Web Store listing for linkward, attaching to the browser
// that `session.mjs` left open.
//
// Everything here is a field the Web Store API cannot touch: the publish API
// has upload/publish/fetchStatus and nothing else, so the listing is either
// typed by a human or typed by this. The dashboard is an Angular app whose
// element ids are generated per render, so nothing is selected by id — only by
// the text a person would read, and the file inputs by the slot they sit in.
import { readFileSync } from 'node:fs';
import { dashboard } from './dashboard.mjs';

const ITEM = 'pbegofhlnmdodohhgpaalhglnjchakfb';
const DESCRIPTION = readFileSync(new URL('./listing.txt', import.meta.url), 'utf8').trim();

const { browser, page } = await dashboard(ITEM);
const step = (m) => console.log(`· ${m}`);

/**
 * Material selects render their options into an overlay shared by the whole
 * page, so `[role=option]` on its own matches every dropdown at once. The
 * panels do carry an aria-label naming their field, and that is what makes the
 * choice unambiguous.
 */
async function choose(currentText, panel, option) {
  await page.locator('[role="combobox"]', { hasText: currentText }).first().click();
  const list = page.getByRole('listbox', { name: panel, exact: true });
  await list.waitFor({ timeout: 10_000 });
  await list.getByRole('option', { name: option, exact: true }).click();
  await page.waitForTimeout(600);
}

// A dropdown left open by an earlier run would swallow the first click.
await page.keyboard.press('Escape');

step('description');
const desc = page.locator('textarea').first();
await desc.fill(DESCRIPTION);
await desc.blur();

step('category → Datenschutz & Sicherheit');
await choose('Kategorie auswählen', 'Kategorie', 'Datenschutz & Sicherheit');

step('language → Englisch (Vereinigte Staaten)');
await choose('Sprache auswählen', 'Sprache', 'Englisch (Vereinigte Staaten)');

// The four file inputs, in the order the page lays them out: icon, screenshots,
// small promo tile, large promo tile. Only the first two are required.
const files = page.locator('input[type=file]');
step('icon 128×128');
await files.nth(0).setInputFiles('dist/icons/icon-128.png');
await page.waitForTimeout(3000);
step('screenshot 1280×800');
await files.nth(1).setInputFiles('docs/store/01-picker.png');
await page.waitForTimeout(4000);

step('homepage and support URLs');
for (const [label, url] of [
  ['URL der Startseite', 'https://github.com/sapn95/linkward'],
  ['Support-URL', 'https://github.com/sapn95/linkward/issues'],
]) {
  const box = page.getByLabel(label, { exact: false }).first();
  if (await box.count()) await box.fill(url);
}

step('save');
await page.getByRole('button', { name: 'Speichern' }).first().click();
await page.waitForTimeout(5000);

await page.screenshot({ path: '/tmp/cws-after-listing.png', fullPage: true });
console.log('done —', page.url());
await browser.close();
