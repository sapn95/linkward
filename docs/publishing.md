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

### The item itself has to be made by hand, once

**The Chrome Web Store API cannot create an item.** It has `upload`, `publish`,
`fetchStatus`, `cancelSubmission` and `setPublishedDeployPercentage`, and no
create — and the documentation is explicit that "before you can publish a new
item, you have to fill out the Store listing and Privacy tabs in the Developer
Dashboard". Trying anyway answers `400 Invalid Value`, which reads like a
problem with the zip and is not.

So: `npm run build -- --zip`, then **New item** in the
[dashboard](https://chrome.google.com/webstore/devconsole) and upload
`linkward-v*.zip`. The 32-letter id in the URL afterwards is
`CHROME_EXTENSION_ID`.

### Then, once

```bash
CHROME_CLIENT_ID=… CHROME_CLIENT_SECRET=… CHROME_REFRESH_TOKEN=… \
CHROME_EXTENSION_ID=… AMO_JWT_ISSUER=… AMO_JWT_SECRET=… \
node scripts/setup-stores.mjs
```

It checks the Google credentials really work and that the item is reachable
with them, then writes every secret into the repository. Nothing is echoed. The
AMO pair is optional — the two stores are independent, and a missing Mozilla key
should not hold up the Chrome half.

> **A refresh token is bound to the client that minted it.** Always take all
> three Chrome values from the SAME downloaded `client_secret_*.json`. A fresh
> token against a stale client id fails with `invalid_client`, which reads like
> a permissions problem and is not.

> Publish the OAuth consent screen (**In production**). While it is in Testing,
> Google expires every refresh token after seven days.

## What only a human can do

Neither store has an API for these. That is deliberate: they are legal
statements by the publisher — but "no API" does not have to mean "click through
a form in a language you did not choose". `scripts/store/` drives the real
dashboard instead:

```sh
node scripts/store/session.mjs       # opens your Chrome, keeps a debug port open
node scripts/store/probe.mjs [url]   # says which fields are on the page, and what they are called
node scripts/store/fill-listing.mjs  # Chrome: description, category, language, icon, screenshot, links
node scripts/store/fill-privacy.mjs  # Chrome: single purpose, permission justifications, disclosures
node scripts/store/submit.mjs        # Chrome: submit for review (dry run without --confirm)
node scripts/store/amo-listing.mjs   # Firefox: description, icon, screenshot, links
```

Both stores are driven from the one Chrome window — AMO's dev hub is an
ordinary website, and signing in to it there is no different from anywhere
else.

`session.mjs` starts your **installed Chrome** — not a downloaded Chromium,
because Google's sign-in refuses builds it does not recognise — with a profile
under `~/.cache/`, so you sign in once by hand and it sticks. Every other script
attaches to that same window over CDP. `probe.mjs` exists because the dashboard
generates its element ids per render: nothing is selected by id, only by the
text a person would read, and that text depends on the language your Google
account is in.

The prose lives beside the scripts (`listing-chrome.txt`, `listing-firefox.txt`,
`fill-privacy.mjs`), so a wording change is a diff and a review, not a memory of
what was typed into a text box eight months ago. The two descriptions differ
because the two builds do: only one of them has containers, and only one can
stop a request before it is sent.

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

- The **first upload creates the add-on**, but only if the release carries the
  two fields AMO will not take from the manifest. They live in
  `docs/store/amo-metadata.json`, and AMO reports them one per attempt:

  | Missing           | What it says                                                    |
  | ----------------- | --------------------------------------------------------------- |
  | `version.license` | This field, or custom_license, is required for listed versions. |
  | `categories`      | This field is required for add-ons with listed versions.        |

- Everything else — description, icon, screenshot, links — is
  `scripts/store/amo-listing.mjs`.

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
