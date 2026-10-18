# The native messaging helper

A Firefox extension **cannot start another application**. There is no API for
it: `protocol_handlers` only registers Firefox _as_ a handler, and
`downloads.open()` hands the file to whatever the system default already is. So
"open this link in Chrome" needs a helper outside the browser, and this is it.

## Install

macOS and Linux:

```sh
./native/install.sh
```

Windows, in PowerShell:

```powershell
.\native\install.ps1
```

That writes `ch.sapn.linkward.json` into Firefox's
`NativeMessagingHosts` directory with an absolute path to `host.mjs`, and allows
exactly one extension id to talk to it. Then switch the feature on in linkward's
settings — Firefox asks for the `nativeMessaging` permission at that point,
which is why the permission is **optional** and nobody sees it at install.

Needs `node` on **your** `PATH` at install time, and not on Firefox's: the
installer resolves it once and writes a wrapper holding the absolute path.
Firefox starts the helper with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — measured,
not assumed — so an `#!/usr/bin/env node` line finds nothing when node lives in
`/opt/homebrew/bin` or a version manager. Getting that wrong looks exactly like
"the helper is not installed", which is the one symptom installing it again
cannot fix.

Most people never run these scripts. linkward's settings page carries both
sources and writes an installer for the machine it is running on, so switching
the feature on is a download and one line. No architecture split: this is a node script, so arm64
and x86-64 run the same file.

Windows differs in two ways, which is why it has its own script. Firefox finds
the manifest through the **registry** rather than a directory, and the manifest
must point at something Windows can execute — a `.mjs` is not, so a `.cmd`
wrapper is written beside it and that is what gets registered. The key goes in
`HKCU`, so no administrator is needed.

## What it does

Three commands and deliberately no more.

| Command | Answer                                                                     |
| ------- | -------------------------------------------------------------------------- |
| `list`  | every installed app that declares it can open an `http` URL, minus Firefox |
| `open`  | runs `open -a <app> <url>`                                                 |
| `icons` | a 32px PNG as a `data:` URL for each path given, for the picker's buttons  |

`icons` takes the whole set in one message, not one path per message. Firefox
starts a fresh helper process per `sendNativeMessage`, and the first thing this
one does is read every application bundle on the machine — asking per icon paid
that scan once per button, measured at 1.27s for three. One call for four is
0.66s, nearly all of it the single scan.

An icon is decoration, so every failure answers with that path simply missing
from the map and the picker draws the name alone. On Windows the map comes back
empty: the icon lives inside the `.exe`, and pulling it out needs a decoder
this helper is not going to carry.

Browsers are found by **capability**, never by a list of known names: a list is
wrong the first time somebody installs a browser nobody thought of, and it would
take a release to learn one. Each platform has its own form of the same
question, and the third column is the one that does the work.

|         | Where it looks                      | Qualifies on                                           |
| ------- | ----------------------------------- | ------------------------------------------------------ |
| macOS   | `Info.plist` of every `.app`        | `http`, `https` **and** `file`                         |
| Linux   | `.desktop` entries                  | `x-scheme-handler/http`, `…/https` **and** `text/html` |
| Windows | `StartMenuInternet` in the registry | being registered there at all                          |

On macOS, `file` was measured rather than assumed: iTerm2, Hammerspoon and VLC
all claim `http` and `https`, and Launch Services agrees they are http handlers.
None of them claims `file`. A browser opens a local page too. `text/html` is the
same capability in the shape the Linux desktop uses. Windows keeps the list
itself, so reading it _is_ the check.

The decision is in [`parse.mjs`](parse.mjs), which takes text rather than a
filesystem: the helper can only ever run on one platform at a time, so the part
that decides is tested against fixtures from all three.

## What it does not do

It reads no page, stores nothing, and makes no network request. It refuses any
URL that is not `http:` or `https:`, and any path that is not an existing
absolute path — the picker page is web-accessible, so a `file://` or
`javascript:` string can reach the extension, and it must never reach `open`.

The extension checks the path against the list this helper itself reported
before sending it. Both checks are deliberate: the one here is the one that
counts, because this process is reachable by anything the browser lets talk to
it.
