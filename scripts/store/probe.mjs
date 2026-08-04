// Attaches to the running session and says what is on the screen: the URL, the
// heading, and every form control it can see with the label a human would read.
// This is the step that makes the rest possible — the dashboard is an Angular
// app whose ids change, so the selectors are found, not guessed.
import { dashboard } from './dashboard.mjs';

const { browser, page } = await dashboard();

const url = process.argv[2];
if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

console.log('URL   :', page.url());
console.log('TITLE :', await page.title());

const fields = await page.evaluate(() => {
  const label = (el) => {
    const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return (
      byFor?.innerText ||
      el.closest('label')?.innerText ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.closest('[role="group"],section,form')?.querySelector('h2,h3,legend')?.innerText ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
  };
  const seen = [...document.querySelectorAll('input,textarea,select,[role="combobox"],button')];
  return seen
    .filter((el) => el.offsetParent !== null || el.type === 'file')
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || el.getAttribute('role') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      label: label(el),
      value: (el.value ?? '').toString().slice(0, 40),
    }))
    .slice(0, 120);
});
console.log(JSON.stringify(fields, null, 1));

await page.screenshot({ path: '/tmp/cws-now.png' });
await browser.close();
