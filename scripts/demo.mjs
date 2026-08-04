// Fires links at a browser from OUTSIDE it, which is the only way to see what
// linkward does. Clicking a link on a page is deliberately never intercepted,
// so a demo done in the browser demonstrates nothing.
//
//   node scripts/demo.mjs                 one link, the plain case
//   node scripts/demo.mjs --all           the whole tour, one link at a time
//   node scripts/demo.mjs --browser=Safari
//   node scripts/demo.mjs https://intranet.example/page
//
// It uses the operating system's "open this link" hand-off — the same path a
// mail client, a chat app or a PDF viewer takes. That matters: the point being
// demonstrated is that the link never reaches the browser's own history of
// where it came from, which is why linkward can tell it apart from a click.

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

const args = process.argv.slice(2);
const browser = args.find((a) => a.startsWith('--browser='))?.slice('--browser='.length);
const custom = args.filter((a) => !a.startsWith('--'));

// Each one shows a different answer the picker can give.
const TOUR = [
  {
    url: 'https://example.com/?linkward=plain',
    say: 'The ordinary case: pick a container, or open it without one.',
  },
  {
    url: 'https://example.com/reports/2026/q3/forecast.xlsx?download=1&token=abcdef0123456789',
    say: 'A long address — the picker shows all of it, as text, never as a link.',
  },
  {
    url: 'https://sub.domain.example.com/deep/path?a=1&b=2#section',
    say: 'A subdomain: "never ask for example.com" would cover this one too.',
  },
  {
    url: 'https://example.org/?linkward=second-host',
    say: 'A second host, to show that remembering one does not remember the other.',
  },
];

/** The OS hand-off. Anything else would be a click, and clicks are not ours. */
async function fire(url) {
  const os = platform();
  if (os === 'darwin') {
    await run('open', browser ? ['-a', browser, url] : [url]);
  } else if (os === 'win32') {
    await run('cmd', ['/c', 'start', '', url]);
  } else {
    await run('xdg-open', [url]);
  }
}

const links = custom.length
  ? custom.map((url) => ({ url, say: '' }))
  : args.includes('--all')
    ? TOUR
    : TOUR.slice(0, 1);

console.log(
  links.length > 1 ? `${links.length} links, one at a time. Press Enter for the next one.\n` : '',
);

for (const [i, link] of links.entries()) {
  if (link.say) console.log(`${i + 1}. ${link.say}`);
  console.log(`   ${link.url}\n`);
  await fire(link.url);
  if (i < links.length - 1) await waitForEnter();
}

/** One at a time, so the picker is not buried under four tabs at once. */
function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}
