// Submits the item for review. Separate from the two fill scripts on purpose:
// filling a draft is reversible, this is the step that hands the extension to
// Google and, once approved, to the public.
//
// Run with --confirm to actually go through with it; without it, the dialog is
// only shown and then dismissed.
import { dashboard } from './dashboard.mjs';

const ITEM = 'pbegofhlnmdodohhgpaalhglnjchakfb';
const confirm = process.argv.includes('--confirm');

const page = await dashboard(ITEM);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

const submit = page.getByRole('button', { name: /Prüfen lassen|Submit for review/ }).first();
if (!(await submit.isEnabled())) {
  throw new Error('Submit is still greyed out — something in the draft is unfinished.');
}

await submit.click();
await page.waitForTimeout(2500);

const dialog = page.locator('[role=dialog]').first();
console.log('--- dialog ---');
console.log(await dialog.innerText());
console.log('--- buttons ---');
console.log((await dialog.getByRole('button').allInnerTexts()).join(' | '));

if (!confirm) {
  console.log('\nDry run. Pass --confirm to submit.');
  await page.keyboard.press('Escape');
  process.exit(0);
}

await dialog
  .getByRole('button', { name: /Veröffentlichen|Publish|Einreichen|Submit/ })
  .first()
  .click();
await page.waitForTimeout(6000);
console.log(
  '\nstatus now:',
  await page
    .locator('body')
    .innerText()
    .then((t) => t.slice(0, 200)),
);
