# Publishing

Two stores, one release workflow, and a small amount of clicking that no API
can do for you. This page is the whole of it.

## Once, per repository

Five of the six secrets belong to your **account**, not to this extension: the
same Google OAuth client and the same AMO API key serve every add-on you
publish. If you already ship something else, they are the values you already
have.

| Secret                 | Where it comes from                                          |
| ---------------------- | ------------------------------------------------------------ |
| `CHROME_CLIENT_ID`     | Google Cloud → **Clients**, a **Desktop app** client         |
| `CHROME_CLIENT_SECRET` | the same client                                              |
| `CHROME_REFRESH_TOKEN` | minted from that client, see below                           |
| `CHROME_EXTENSION_ID`  | **created by the script below** — the only per-extension one |
| `AMO_JWT_ISSUER`       | <https://addons.mozilla.org/developers/addon/api/key/>       |
| `AMO_JWT_SECRET`       | the same page                                                |

Then:

```bash
npm run build -- --zip
CHROME_CLIENT_ID=… CHROME_CLIENT_SECRET=… CHROME_REFRESH_TOKEN=… \
AMO_JWT_ISSUER=… AMO_JWT_SECRET=… \
node scripts/setup-stores.mjs
```

It creates the Chrome Web Store item over the API — a POST with no item id is
what makes a new one — and writes all six secrets into the repository. Nothing
is echoed.

> **A refresh token is bound to the client that minted it.** Always take all
> three Chrome values from the SAME downloaded `client_secret_*.json`. A fresh
> token against a stale client id fails with `invalid_client`, which reads like
> a permissions problem and is not.

> Publish the OAuth consent screen (**In production**). While it is in Testing,
> Google expires every refresh token after seven days.

## What only a human can do

Neither store has an API for these. That is deliberate: they are legal
statements by the publisher.

**Chrome Web Store** → <https://chrome.google.com/webstore/devconsole>

- **Store listing** — description, category, a 128×128 icon, at least one
  1280×800 screenshot. It will not publish without them.
- **Privacy practices** — a justification for every permission, optional ones
  included. `<all_urls>` is the one a reviewer will read closely. Ready wording:

  > Requested at runtime, never at install, and only when the user switches the
  > feature on. It is used solely to stop a top-level navigation in a newly
  > opened tab so the user can choose which container it should open in. No page
  > content is read, nothing is stored about which pages were visited, and
  > nothing is transmitted anywhere. Switching the feature off calls
  > `permissions.remove` and hands the access back.

- Then **Submit for review**. After the first approval, releases publish
  themselves.

**Firefox AMO** → <https://addons.mozilla.org/developers/>

- The **first upload creates the listing**. Run the release workflow once, then
  fill in the summary, category and privacy policy on the page it made.

## Releasing

`Actions → Release → Run workflow`, with the `tag` field empty.

The bump comes from the commit subjects: a `!` or `BREAKING CHANGE` is major,
any `feat` is minor, everything else is a patch.

`main` is protected, so the workflow does not push to it. It pushes a
`release/vX.Y.Z` branch, opens a pull request, approves its own held runs,
waits for the checks, squash-merges, and tags the commit that actually landed —
a squash rewrites the commit, so a tag made before the merge would name a SHA
that never reaches `main`.

## When a release does not publish

| Message                         | Meaning                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 Publish condition not met` | The zip is up, but the **Privacy practices** tab needs completing. Every newly added permission needs its own justification, which is why an otherwise routine release suddenly stops publishing. |
| `ITEM_NOT_UPDATABLE`            | Nothing was uploaded — a previous submission is still in review. Wait, then re-run the workflow with `tag` set to that version.                                                                   |

Both open a tracking issue so a green run that shipped nothing cannot go
unnoticed. It closes itself when a later run publishes.
