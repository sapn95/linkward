// One-shot store setup, so nobody has to click through two dashboards.
//
// What it does, given the credentials in the environment: checks that the
// Google credentials really work, writes every secret into the GitHub repo so
// `release.yml` runs, and then tells you the exact things that cannot be
// automated, and why.
//
// It does NOT create the Chrome Web Store item, because **the API cannot**: the
// Web Store API has upload, publish, fetchStatus, cancelSubmission and
// setPublishedDeployPercentage, and no create. The docs say it plainly — "before
// you can publish a new item, you have to fill out the Store listing and Privacy
// tabs in the Developer Dashboard". So the item is made once by hand and its id
// is handed to this script.
//
// Five of the six secrets belong to the ACCOUNT, not to this extension: the same
// Google OAuth client and the same AMO API key serve every add-on the same
// person publishes. If you already ship something else, they are the values you
// already have — this script does not invent new ones.
//
// Usage:
//   CHROME_CLIENT_ID=… CHROME_CLIENT_SECRET=… CHROME_REFRESH_TOKEN=… \
//   CHROME_EXTENSION_ID=… AMO_JWT_ISSUER=… AMO_JWT_SECRET=… \
//   node scripts/setup-stores.mjs
//
// Nothing is printed that could leak a secret: values are written to GitHub
// through `gh secret set --body`, never echoed.

import { execFileSync } from 'node:child_process';

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
const EXTENSION_ID = env('CHROME_EXTENSION_ID');
const CLIENT_SECRET = env('CHROME_CLIENT_SECRET');
const REFRESH_TOKEN = env('CHROME_REFRESH_TOKEN');
// The AMO pair is optional here on purpose: the two stores are independent, and
// having to hold up the Chrome item because a Mozilla key is not to hand would
// be a rule this script invented for itself.
const AMO_ISSUER = process.env.AMO_JWT_ISSUER;
const AMO_SECRET = process.env.AMO_JWT_SECRET;

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

/** Prove the item exists and that these credentials can reach it. */
async function checkItem(token) {
  const res = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${EXTENSION_ID}?projection=DRAFT`,
    { headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' } },
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `The item ${EXTENSION_ID} is not reachable with these credentials: ` +
        `${JSON.stringify(json.error ?? json)}`,
    );
  }
  return json;
}

function setSecret(name, value) {
  execFileSync('gh', ['secret', 'set', name, '--repo', REPO, '--body', value], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  console.log(`  set ${name}`);
}

const token = await accessToken();
console.log('Google credentials accepted.');

await checkItem(token);
console.log(`Chrome Web Store item ${EXTENSION_ID} reachable.`);

console.log('Writing the repository secrets:');
setSecret('CHROME_CLIENT_ID', CLIENT_ID);
setSecret('CHROME_CLIENT_SECRET', CLIENT_SECRET);
setSecret('CHROME_REFRESH_TOKEN', REFRESH_TOKEN);
setSecret('CHROME_EXTENSION_ID', EXTENSION_ID);
if (AMO_ISSUER && AMO_SECRET) {
  setSecret('AMO_JWT_ISSUER', AMO_ISSUER);
  setSecret('AMO_JWT_SECRET', AMO_SECRET);
} else {
  console.log('  AMO_JWT_ISSUER / AMO_JWT_SECRET not given — Firefox publishing stays off');
}

console.log(`
Done. What is left cannot be done through an API, and this is not an oversight
on anyone's part — they are legal statements by the publisher:

  Chrome Web Store  https://chrome.google.com/webstore/devconsole
    - The item itself: "New item" and upload the zip. There is no API for this.
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
