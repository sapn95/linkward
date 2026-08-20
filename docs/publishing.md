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
>
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

- The icon and the screenshots are **not** by hand: every release syncs them
  through the API — see [The listing art](#the-listing-art) below.
- The description and the links have no API at all, so those stay in
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

## The listing art

`npm run amo:art`, run by the release workflow immediately after the AMO sign
step. Firefox only: the Chrome Web Store has no API for a screenshot, so its
listing stays a dashboard job.

It uploads `dist-firefox/icons/icon-128.png` as the listing icon and every
numbered PNG in [`docs/store/amo/`](store/amo/) — `01-*.png`, `02-*.png`, … — as
the screenshots, in filename order. It is **declarative**: each run posts the
whole set and then deletes the previews that were there before, so running it
twice leaves the listing identical and accumulates nothing.

It is also the recovery path, and it is safe to run by hand with the two
secrets in the environment. A sync that stopped — because AMO was read-only,
because the add-on did not exist yet, because a request timed out — is finished
by running it again. There is nothing to undo first.

### Why the AMO screenshots have a directory of their own

`docs/store/` serves both stores, and the two pictures of the picker differ by
the one thing that matters:

| File                              | Store  | Shows                                      |
| --------------------------------- | ------ | ------------------------------------------ |
| `docs/store/amo/01-picker.png`    | AMO    | the container list — Work, Personal, Admin |
| `docs/store/01-picker-chrome.png` | Chrome | no containers, because Chrome has none     |

Both are 1280×800 and both match `01-*.png`. A single glob over `docs/store/`
would have posted the Chrome picture to Mozilla — a picker with the containers
missing, on the listing people install it for containers from — at position 0 or
1 depending on nothing but a lexical sort. No pattern can be made to guess this
right, so **where a file lives is what says which store it is for**, and
`tests/amo-art.test.js` holds the uploader to it.

### What that API costs to learn

- **There is no image replace.** `PATCH .../previews/<id>/` accepts a new image,
  answers `200` — and keeps the old one. Only the caption and the position are
  writable after creation, so replacing a screenshot is POST then DELETE.
  **In that order**: deleting first opens a window in which the live listing has
  no screenshots at all, and every way a run can stop inside that window leaves
  the store page bare. Posting first fails into duplicates, which are visible
  and are repaired by running it again.
- **Reading the current set** is a third quirk: `GET` on the previews collection
  is a `405`, so the existing previews come off `previews[]` on the add-on
  detail.
- **Captions do not come from here.** A preview is posted with an image and a
  position and nothing else, so the caption that `amo-listing.mjs` typed into
  the dev hub on the first fill goes with the preview it belonged to. The
  picture carries its own headline, which is why this has not been worth two
  more requests out of an hourly budget of ten — but it is the one thing a sync
  takes away.
- **The declared part type is what gets validated**, not the bytes. A bare
  `Buffer` appended to a `FormData` goes out as `application/octet-stream`, and
  a perfectly good PNG comes back as _"Images must be either PNG or JPG."_ Wrap
  it: `new Blob([buf], { type: 'image/png' })`.
- **Uploads are paced about 21 seconds apart.** Preview create and delete count
  against the same add-on submission throttle as the version upload that
  `web-ext sign` made minutes earlier — 3 a minute, 10 an hour — and a naive
  loop `429`s on its fourth call. A sync that cannot fit in the hourly bucket
  refuses to start rather than posting half a set.
- **The Firefox build, not the Chrome one.** The guid and the icon both come
  from `dist-firefox/`; `dist/` is a Chrome manifest with no
  `browser_specific_settings`, so reading the add-on id there throws.

Size: AMO stores a preview at up to 2400×1800, downscaling anything larger and
never upscaling anything smaller. Its gallery card is 320×200, so 1.6:1 fills
the card and 4:3 letterboxes it — the 1280×800 shipped here is exactly 1.6:1 and
also the size the Chrome dashboard asks for, which is why one staged HTML file
per store is enough. There is no minimum and no ratio rule on the API path; the
1000×750 check belongs to the devhub form, which this never touches.

### One screenshot

The listing shows one, and it is the picker: the whole product is that one
dialog, and the picture already carries the pitch beside it. A second would have
to be the settings page — the list of hosts you have stopped being asked about,
which answers "will this nag me forever?" — and that is a real question, but it
is answered in the store description too, and a screenshot of a form full of
example.com is thinner than the one good picture next to it.

There is no renderer to make one with, either: `docs/store/screenshot.html` and
`screenshot-chrome.html` are staged pictures of the picker, opened and captured
by hand, and staging a settings page by hand means drawing a screen rather than
photographing one. If a second slot is ever worth filling, the honest way is to
capture the real options page out of a profile with a few rules in it. Until
then, one good screenshot beats two.

## When a release does not publish

| Message                         | Meaning                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 Publish condition not met` | The zip is up, but the **Privacy practices** tab needs completing. Every newly added permission needs its own justification, which is why an otherwise routine release suddenly stops publishing.                                                                                                                      |
| `ITEM_NOT_UPDATABLE`            | Nothing was uploaded — a previous submission is still in review. Wait, then re-run the workflow with `tag` set to that version. **Firefox is held back too**, so the two stores cannot end up on different versions; a privacy gate does not hold it back, because that package is already up and publishes by itself. |

Both open a tracking issue so a green run that shipped nothing cannot go
unnoticed. It closes itself when a later run publishes.

### …and when the listing art does not go up

The art step is the last one in the job, and the version has already published
by the time it runs — so it warns and stays green wherever it stopped without
touching anything, and reds wherever a run could not finish or did not.

| Message                                | Meaning                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AMO secrets incomplete`               | The two secrets are not both set. Nothing was uploaded; nothing is broken.                                                                                                |
| `No add-on on AMO under this id`       | The art step ran before a listing existed. The next release uploads it.                                                                                                   |
| `AMO is read-only right now`           | Mozilla is mid-deploy or mid-incident. The version published; the art follows next release.                                                                               |
| `AMO uploads are switched off`         | The same, as a `503` from the icon upload rather than up front. Nothing had been touched yet.                                                                             |
| `the listing has already been changed` | Red: part of the set is up and the sync stopped there. `npm run amo:art` with the secrets set finishes it, and nothing needs undoing first.                               |
| `this sync needs N throttled requests` | Red before anything was sent: the set plus the previews already on the listing is past AMO's ten-an-hour bucket. Ship fewer screenshots, or run it by hand an hour later. |
