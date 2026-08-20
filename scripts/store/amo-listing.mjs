// Fills the AMO listing, attaching to the browser that `session.mjs` left open.
//
// The first upload creates the add-on and takes its name, summary, licence and
// categories from the manifest and from docs/store/amo-metadata.json. What it
// cannot take from anywhere is the long description, a screenshot and the
// links, and an add-on without them looks abandoned on its own product page.
//
// AMO's dev hub is a plain server-rendered form, not an app: each section is
// revealed by its own "Edit" link and saved by its own "Save Changes" button,
// and the field names (`description_en-us`, `support_url_en-us`) are stable.
// So unlike the Chrome dashboard, this one can be addressed by name.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const SLUG = 'linkward';
const EDIT = `https://addons.mozilla.org/en-US/developers/addon/${SLUG}/edit`;
const DESCRIPTION = readFileSync(new URL('./listing-firefox.txt', import.meta.url), 'utf8').trim();

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page =
  browser
    .contexts()[0]
    .pages()
    .find((p) => new URL(p.url()).hostname === 'addons.mozilla.org') ??
  (await browser.contexts()[0].newPage());

const step = (m) => console.log(`· ${m}`);

/** Reveal one section's form. Each section is independent, and saves alone. */
async function open(section) {
  await page.goto(EDIT, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const box = page.locator(`#edit-addon-${section}`);
  await box.getByRole('link', { name: 'Edit' }).first().click();
  await box.locator('form').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  return box;
}

/** The overview lists every field with its current value, or "None". */
let overview = '';
function summaryLine(field) {
  return overview.split('\n').find((l) => l.startsWith(field));
}

async function save(box) {
  await box
    .getByRole('button', { name: /Save Changes/i })
    .first()
    .click();
  await page.waitForTimeout(4000);
}

await page.goto(EDIT, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
overview = await page.locator('#edit-addon').innerText();

step('description and support link');
let box = await open('describe');
await box.locator('textarea[name="description_en-us"]').fill(DESCRIPTION);
await box.locator('input[name="support_url_en-us"]').fill(`https://github.com/sapn95/${SLUG}`);
// Deliberately no support e-mail: the only address this account publishes is a
// noreply one, and an address that bounces is worse than none. AMO takes either.
await save(box);

step('icon and screenshot');
// scripts/amo-art.mjs owns both of these now, over the API, on every release.
// This half is what fills a listing that has never had a release — and it stays
// because the description and the links below have no API at all, so the run
// happens anyway.
//
// Two separate uploaders share this section, and picking one by position gets
// it wrong: the first run uploaded a screenshot and left the add-on with no
// icon at all. Both are addressed by name.
const hadScreenshot = !summaryLine('Screenshots')?.includes('None');
box = await open('media');
await box.locator('input[name="icon_upload"]').setInputFiles('dist-firefox/icons/icon-128.png');
await page.waitForTimeout(6000);
if (!hadScreenshot) {
  // Uploading again would add a SECOND copy rather than replace the first.
  // The Firefox picture: containers, which is the half of linkward that only
  // works here. It lives under docs/store/amo/ because the Chrome one is its
  // twin apart from that, one directory up, and a path is the only thing that
  // tells the two apart reliably.
  await box.locator('input[name="uploads"]').setInputFiles('docs/store/amo/01-picker.png');
  await page.waitForTimeout(6000);
}
const caption = box.locator('textarea[name="files-0-caption_en-us"]');
if (await caption.count()) await caption.fill('Choosing where an external link should open.');
await save(box);

step('homepage');
box = await open('details');
const home = box.locator('input[name="homepage_en-us"]');
if (await home.count()) await home.fill(`https://github.com/sapn95/${SLUG}`);
await save(box);

// Read the whole listing back. A save that silently did nothing is the failure
// mode worth catching here, not a crash.
await page.goto(EDIT, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
overview = await page.locator('#edit-addon').innerText();
for (const field of ['Description', 'Screenshots', 'Homepage', 'Website']) {
  const line = summaryLine(field);
  console.log(`  ${field}: ${!line || line.includes('None') ? 'STILL EMPTY' : 'set'}`);
}
console.log('done —', page.url());
