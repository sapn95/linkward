// Store screenshots, rendered from the REAL pages at the exact size both stores
// want (1280×800).
//
// Not mock-ups. A screenshot drawn by hand stops matching the moment somebody
// changes a stylesheet, and the whole point of a store screenshot is to show
// what the thing actually looks like. These load `src/pick/pick.html` and
// `src/options/options.html` in headless Chrome with a stubbed `chrome.*` and a
// set of plausible containers, so re-running this after a UI change produces a
// current picture with no drawing involved.
//
//   npm run screenshots      → docs/store/*.png
//
// ⚠️ NOT WORKING YET. Headless Chrome does not come back: the new headless keeps
// a browser process alive and ignores --virtual-time-budget, and the old one did
// not exit either. Every run so far has had to be killed, and the killing is
// what put ERR_NETWORK_IO_SUSPENDED into the picture — the local server dies
// mid-load. Committed rather than thrown away because the approach is right and
// only the driving is wrong; a CDP client (or Playwright, at the cost of a
// dependency) would replace execFileSync here.
//
// Until then, take the screenshots by hand from the loaded extension. That is
// also the more honest picture: it shows the real browser chrome around it.
//
// Chrome's own binary does the rendering; there is no dependency to install.
// Served over http rather than opened as a file, because ES modules do not load
// from file:// — the page would come up blank, which is exactly what the first
// attempt produced.

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'store');
const TMP = join(ROOT, '.screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// What the pages are shown with. Named after real containers rather than
// "Container 1", because a store screenshot is read in two seconds and generic
// names make it look like a demo of nothing.
const CONTAINERS = [
  { cookieStoreId: 'firefox-container-1', name: 'Personal', color: 'green' },
  { cookieStoreId: 'firefox-container-2', name: 'Work', color: 'red' },
  { cookieStoreId: 'firefox-container-3', name: 'Admin', color: 'pink' },
];

const SHOTS = [
  {
    name: '01-picker',
    page: 'src/pick/pick.html',
    // A URL that shows why this exists at all: a document link with an account
    // in it, of the kind that opens as the wrong person.
    search: `?url=${encodeURIComponent(
      'https://example.sharepoint.com/sites/finance/Shared%20Documents/Q3.xlsx?web=1',
    )}`,
    settings: { rememberChoices: true },
  },
  {
    name: '02-options',
    page: 'src/options/options.html',
    search: '',
    settings: { enabled: true, rememberChoices: true, neverAsk: ['intranet.example'] },
    granted: true,
  },
];

/**
 * Enough of a browser for these two pages. Injected before the page's own
 * module runs — hence `document_start` ordering by putting it in the <head>.
 */
function stub({ containers, settings, granted }) {
  return `<script>
    (() => {
      const local = { localSettings: {} };
      const sync = { settings: ${JSON.stringify(settings)} };
      const area = (store) => ({
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => Object.assign(store, o),
      });
      globalThis.chrome = {
        runtime: { getURL: (p) => 'moz-extension://linkward/' + p, sendMessage: () => {} },
        storage: { sync: area(sync), local: area(local) },
        tabs: {
          create: async () => ({ id: 2 }),
          getCurrent: async () => ({ id: 1 }),
          remove: async () => {},
        },
      };
      globalThis.browser = {
        contextualIdentities: { query: async () => ${JSON.stringify(containers)} },
        permissions: {
          contains: async () => ${granted ? 'true' : 'false'},
          request: async () => true,
          remove: async () => true,
        },
      };
    })();
  </script>`;
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

// The WHOLE source tree, so every relative import and stylesheet resolves the
// way it does in the real extension. Only the two pages are patched.
cpSync(join(ROOT, 'src'), TMP, { recursive: true });

for (const shot of SHOTS) {
  const page = join(TMP, shot.page.replace(/^src\//, ''));
  const html = readFileSync(page, 'utf8').replace(
    '</head>',
    `${stub({ containers: CONTAINERS, ...shot })}</head>`,
  );
  writeFileSync(page, html);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = join(TMP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(TMP) || !existsSync(path)) {
    res.writeHead(404).end();
    return;
  }
  const ext = path.slice(path.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

for (const shot of SHOTS) {
  const url = `http://127.0.0.1:${port}/${shot.page.replace(/^src\//, '')}${shot.search}`;
  const out = join(OUT, `${shot.name}.png`);
  execFileSync(
    CHROME,
    [
      // The OLD headless, deliberately: it renders, writes the file and exits.
      // The new one keeps a browser process alive and --virtual-time-budget has
      // no effect on it, so the run simply never returns.
      '--headless=old',
      '--disable-gpu',
      // Its own profile directory, and a timeout. Without the first, a headless
      // run tries to attach to the default profile — which is locked whenever a
      // normal Chrome is open — and simply hangs for ever.
      `--user-data-dir=${join(TMP, '.chrome')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1280,800',
      // The pages fetch their containers and settings before painting, so a
      // screenshot taken the instant the DOM is ready catches an empty page.
      '--virtual-time-budget=3000',
      `--screenshot=${out}`,
      url,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 },
  );
  console.log(`wrote docs/store/${shot.name}.png`);
}

server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`
Both stores want 1280x800, which is what these are. Neither has an API for
uploading them — the listing assets are dashboard-only — so they go up by hand:

  Chrome  https://chrome.google.com/webstore/devconsole → Store listing
  AMO     https://addons.mozilla.org/developers/ → the add-on → Edit listing
`);
