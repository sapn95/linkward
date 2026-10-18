# The native messaging helper

A Firefox extension **cannot start another application**. There is no API for
it: `protocol_handlers` only registers Firefox _as_ a handler, and
`downloads.open()` hands the file to whatever the system default already is. So
"open this link in Chrome" needs a helper outside the browser, and this is it.

## Install

```sh
./native/install.sh
```

That writes `ch.sapn.linkward.json` into Firefox's
`NativeMessagingHosts` directory with an absolute path to `host.mjs`, and allows
exactly one extension id to talk to it. Then switch the feature on in linkward's
settings — Firefox asks for the `nativeMessaging` permission at that point,
which is why the permission is **optional** and nobody sees it at install.

Needs `node` on `PATH`.

## What it does

Two commands and deliberately no more.

| Command | Answer                                                                     |
| ------- | -------------------------------------------------------------------------- |
| `list`  | every installed app that declares it can open an `http` URL, minus Firefox |
| `open`  | runs `open -a <app> <url>`                                                 |

Browsers are found by **capability**, never by a list of known names: a list is
wrong the first time somebody installs a browser nobody thought of, and it would
take a release to learn one. An app that declares the `http` scheme in its
`Info.plist` is a browser for this purpose, whatever it calls itself.

## What it does not do

It reads no page, stores nothing, and makes no network request. It refuses any
URL that is not `http:` or `https:`, and any path that is not an existing
absolute path — the picker page is web-accessible, so a `file://` or
`javascript:` string can reach the extension, and it must never reach `open`.

The extension checks the path against the list this helper itself reported
before sending it. Both checks are deliberate: the one here is the one that
counts, because this process is reachable by anything the browser lets talk to
it.
