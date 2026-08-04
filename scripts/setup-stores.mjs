// One-shot store setup, so nobody has to click through two dashboards.
//
// What it does, given the credentials in the environment:
//   1. creates a NEW Chrome Web Store item by uploading the built zip with no
//      item id — the API returns the id, which is the only per-extension secret;
//   2. writes all six secrets into the GitHub repo, so `release.yml` works;
//   3. tells you the exact things that CANNOT be automated, and why.
//
// Five of the six secrets belong to the ACCOUNT, not to this extension: the same
// Google OAuth client and the same AMO API key serve every add-on the same
// person publishes. If you already ship something else, they are the values you
// already have — this script does not invent new ones.
//
// Usage:
//   npm run build -- --zip
//   CHROME_CLIENT_ID=… CHROME_CLIENT_SECRET=… CHROME_REFRESH_TOKEN=… \
//   AMO_JWT_ISSUER=… AMO_JWT_SECRET=… node scripts/setup-stores.mjs
//
// Nothing is printed that could leak a secret: values are written to GitHub
// through `gh secret set --body`, never echoed.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const REPO = 'sapn95/linkward';

const env = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. See the header of this file for what it is.`);
    process.exit(1);
  }
  return v;
};

const CLIENT_ID = env('CHROME_CLIENT_ID');
const CLIENT_SECRET = env('CHROME_CLIENT_SECRET');
const REFRESH_TOKEN = env('CHROME_REFRESH_TOKEN');
const AMO_ISSUER = env('AMO_JWT_ISSUER');
const AMO_SECRET = env('AMO_JWT_SECRET');

const zip = join(ROOT, `linkward-v${pkg.version}.zip`);
if (!existsSync(zip)) {
  console.error(`No ${zip}. Run: npm run build -- --zip`);
  process.exit(1);
}

/** A refresh token is bound to the client that minted it — all three or none. */
async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    // invalid_grant = the refresh token expired or was revoked.
    // invalid_client = the id/secret are not the ones that minted the token.
    throw new Error(`token: ${json.error ?? res.status} ${json.error_description ?? ''}`);
  }
  return json.access_token;
}

/** POST with no item id creates a new item and returns it. */
async function createItem(token) {
  const res = await fetch('https://www.googleapis.com/upload/chromewebstore/v1.1/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
    body: readFileSync(zip),
  });
  const json = await res.json();
  if (!res.ok || json.uploadState === 'FAILURE') {
    throw new Error(`create: ${JSON.stringify(json.itemError ?? json)}`);
  }
  return json.id;
}

function setSecret(name, value) {
  execFileSync('gh', ['secret', 'set', name, '--repo', REPO, '--body', value], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  console.log(`  set ${name}`);
}

const token = await accessToken();
console.log('Google credentials accepted.');

const itemId = await createItem(token);
console.log(`Chrome Web Store item created: ${itemId}`);

console.log('Writing the repository secrets:');
setSecret('CHROME_CLIENT_ID', CLIENT_ID);
setSecret('CHROME_CLIENT_SECRET', CLIENT_SECRET);
setSecret('CHROME_REFRESH_TOKEN', REFRESH_TOKEN);
setSecret('CHROME_EXTENSION_ID', itemId);
setSecret('AMO_JWT_ISSUER', AMO_ISSUER);
setSecret('AMO_JWT_SECRET', AMO_SECRET);

console.log(`
Done. What is left cannot be done through an API, and this is not an oversight
on anyone's part — they are legal statements by the publisher:

  Chrome Web Store  https://chrome.google.com/webstore/devconsole
    - Store listing: description, category, a 128x128 icon and at least one
      1280x800 screenshot. The item will not publish without them.
    - Privacy practices: a justification for EVERY permission, including the
      optional ones. <all_urls> is the one they will read closely — say that it
      is requested at runtime, only when the user switches the feature on, and
      that no page content is read. Wording in docs/publishing.md.
    - Then Submit for review. Afterwards, releases publish themselves.

  Firefox AMO       https://addons.mozilla.org/developers/
    - The FIRST upload creates the listing. Run the release workflow once and it
      will appear; then fill in the summary, category and privacy policy.

  Neither store has an API for those fields. The publish API can upload and
  publish, and nothing else.
`);
