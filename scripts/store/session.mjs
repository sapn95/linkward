// Opens a real, visible Chrome against the Chrome Web Store dashboard and then
// does nothing but stay alive, with a debugging port open so every later step
// can attach to the SAME window.
//
// Two decisions worth keeping:
//   - Real Chrome, not Playwright's bundled Chromium. Google's sign-in refuses
//     builds it does not recognise ("this browser may not be secure"), and the
//     whole point here is that a human signs in once, by hand.
//   - A persistent profile outside the repo, so that sign-in survives between
//     runs and no cookie ever lands in git.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE = join(homedir(), '.cache', 'linkward-cws-profile');
mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: 'chrome',
  viewport: null,
  args: [
    '--remote-debugging-port=9222',
    '--window-size=1500,1000',
    // Without this the dashboard is still fine, but Google's sign-in is
    // markedly less likely to challenge the session.
    '--disable-blink-features=AutomationControlled',
  ],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://chrome.google.com/webstore/devconsole/', {
  waitUntil: 'domcontentloaded',
});

console.log('READY — sign in in the window that just opened.');
// Idle for two hours; every later step attaches over CDP.
await new Promise((r) => setTimeout(r, 2 * 60 * 60 * 1000));
