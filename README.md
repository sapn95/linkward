# linkward

**Asks where a link should open — before it opens.**

When another application hands a link to your browser — Slack, Outlook, Teams, a
terminal — it lands wherever the browser felt like putting it. Usually the wrong
identity. linkward stops it first and asks:

- open it in **this container**,
- open it **without** one,
- or **copy the link and open nothing at all**.

On Firefox the request is stopped **before it is sent**, so the page is never
fetched, no cookie is set, and no session is started in the wrong container.

## The honest part, up front

**Firefox does not tell an extension that a link came from another
application.** It knows — `isExternal`, in `BrowserDOMWindow.sys.mjs` — and it
does not expose it. What an extension sees for a link handed over by Slack is
`transitionType: "link"`: byte for byte the same as a click on a web page.
[Mozilla's own bug for this](https://bugzilla.mozilla.org/show_bug.cgi?id=1774127)
has been open since 2022.

So linkward does not detect external links. It **excludes** everything it can
positively identify as something else — a tab with an opener, a navigation a
document started, a tab you have already been browsing in — and asks about what
is left. Every rule errs towards **not** asking, because interrupting a link you
clicked yourself is the failure that gets an add-on uninstalled.

The rules are one small, pure file — [`src/lib/candidates.js`](src/lib/candidates.js)
— and it is the most heavily tested thing in the repo.

## Chrome

Two things are different, and the picker says both on the page rather than
hiding them:

- **Chrome MV3 removed blocking `webRequest`**, so linkward can only turn the
  tab around once the navigation has begun. The page may flash.
- **No extension can open a tab in another Chrome profile.** The isolation is
  enforced inside Chromium, not by convention. On Chrome, linkward can hand you
  the link and nothing more — use Chrome's own right-click **"Open Link as
  ‹Profile›"** on the original link, which has been there since Chrome 48.

Containers are a Firefox feature. The Chrome build ships without the
container permissions at all.

## Permissions

Nothing is granted at install. Everything below is requested from the options
page, in one call, when you switch the feature on — and handed back when you
switch it off.

| Permission                         | Why                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<all_urls>`                       | The only one you actually see: _"Access your data for all websites"_. It is what lets linkward stop a page before it loads. Without it there is nothing to intercept. |
| `webRequest`, `webRequestBlocking` | Firefox only. Silently granted. Stopping the request rather than reacting after it.                                                                                   |
| `webNavigation`                    | Chrome only. There is no blocking form there.                                                                                                                         |
| `contextualIdentities`, `cookies`  | Firefox only, required by the manifest: reading your containers' names and colours, and honouring a `cookieStoreId` when opening.                                     |

linkward reads no page content, stores nothing about where you go, and sends
nothing anywhere. See [PRIVACY.md](PRIVACY.md).

## Install

Not published yet.

```bash
npm install
npm run build:firefox   # dist-firefox/
npm run build           # dist/
```

Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
`dist-firefox/manifest.json`.
Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → `dist/`.

## Development

```bash
npm test          # vitest
npm run ci        # lint + format + coverage + package, the same gate CI runs
```

No bundler and no runtime dependencies: the source under `src/` **is** the
artifact. An extension that intercepts navigations should be readable end to end
by whoever reviews it.

## Author & License

Sebastian Winterberger · MIT
