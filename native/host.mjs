#!/usr/bin/env node
// The helper that opens a link in a browser which is not this one.
//
// A Firefox extension cannot start another application. There is no API for it:
// `protocol_handlers` only registers Firefox AS a handler, and
// `downloads.open()` hands the file to whatever the system default already is.
// Native messaging is the only route, which is why this file exists at all and
// why the extension degrades to saying so when it is missing.
//
// Two commands, and deliberately no more. `list` says which browsers are
// installed; `open` starts one on a URL. Nothing here reads a page, stores
// anything, or talks to the network.
//
// macOS, Linux and Windows. No architecture split: this is a node script, so
// arm64 and x86-64 run the same file.

import { readdirSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  macBrowser,
  desktopBrowser,
  windowsBrowsers,
  tidy,
  macIconFile,
  desktopIconPath,
} from './parse.mjs';

const OS = platform();

// Native messaging frames every message with a 32-bit little-endian length.
function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// --- macOS ------------------------------------------------------------------
function macBrowsers() {
  const roots = ['/Applications', join(homedir(), 'Applications')];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.app')) continue;
      const app = join(root, name);
      const plist = join(app, 'Contents', 'Info.plist');
      if (!existsSync(plist)) continue;
      let info;
      try {
        // plutil rather than a plist parser: binary and XML plists both exist
        // in /Applications, and the one that ships with macOS reads both.
        // stderr ignored: a bundle with a plist plutil cannot convert is not
        // an error here, it is simply not a browser — and Firefox logs
        // whatever this process writes to stderr.
        info = JSON.parse(
          execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
            stdio: ['ignore', 'pipe', 'ignore'],
          }),
        );
      } catch {
        continue;
      }
      const browser = macBrowser(info, app, name.replace(/\.app$/, ''));
      if (browser) found.push(browser);
    }
  }
  return found;
}

// --- Linux ------------------------------------------------------------------
const desktopDirs = () => [
  join(homedir(), '.local/share/applications'),
  '/usr/local/share/applications',
  '/usr/share/applications',
  '/var/lib/flatpak/exports/share/applications',
  join(homedir(), '.local/share/flatpak/exports/share/applications'),
];

function linuxBrowsers() {
  const found = [];
  for (const dir of desktopDirs()) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.desktop')) continue;
      let body;
      try {
        body = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const browser = desktopBrowser(body, file.replace(/\.desktop$/, ''));
      if (browser) found.push(browser);
    }
  }
  return found;
}

// --- Windows ----------------------------------------------------------------
function winBrowsers() {
  const found = [];
  const read = (key) => {
    try {
      return execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8' });
    } catch {
      return '';
    }
  };
  for (const root of ['HKLM', 'HKCU']) {
    let keys;
    try {
      keys = execFileSync('reg', ['query', `${root}\\SOFTWARE\\Clients\\StartMenuInternet`], {
        encoding: 'utf8',
      });
    } catch {
      continue;
    }
    found.push(...windowsBrowsers(keys, read));
  }
  return found;
}

/**
 * Every installed browser, whatever this machine is.
 *
 * Firefox itself is excluded: offering to open a link in the browser the link
 * is already in is a button that does nothing.
 */
function installedBrowsers() {
  return tidy(OS === 'darwin' ? macBrowsers() : OS === 'win32' ? winBrowsers() : linuxBrowsers());
}

/**
 * Start a browser on a URL.
 *
 * The URL is checked here and not only in the extension. This process is
 * reachable by anything the browser lets talk to it, and the launcher will hand
 * a `file://` or a `javascript:` string straight to the application.
 *
 * The target is checked against what `list` actually reported, so a path cannot
 * be invented by whoever sent the message.
 */
function openIn(target, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, why: 'not a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, why: `refusing ${parsed.protocol}` };
  }
  const known = installedBrowsers().find((b) => b.path === target);
  if (!known) return { ok: false, why: 'no such browser' };
  try {
    if (OS === 'darwin') {
      if (!existsSync(known.path) || !statSync(known.path).isDirectory()) {
        return { ok: false, why: 'not an application' };
      }
      detach('/usr/bin/open', ['-a', known.path, parsed.href]);
    } else if (OS === 'win32') {
      detach(known.path, [parsed.href]);
    } else {
      // The Exec line can carry arguments of its own, and they come before the
      // URL. Split on whitespace outside quotes, which is what a launcher does.
      const parts = known.path.match(/"[^"]*"|\S+/g) ?? [];
      const bin = (parts.shift() ?? '').replace(/^"(.*)"$/, '$1');
      if (!bin) return { ok: false, why: 'no command' };
      detach(bin, [...parts.map((p) => p.replace(/^"(.*)"$/, '$1')), parsed.href]);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e).slice(0, 120) };
  }
}

/**
 * The browser's own icon, small, as a data URL.
 *
 * A separate command rather than part of `list`, and asked for after the
 * buttons are already on screen. The picker is a page somebody is waiting on
 * with a link in mid-air; four icon conversions in front of the list would be
 * four reasons to look at nothing.
 *
 * A path with no icon to be had is simply missing from the map rather than an
 * error. Having none is an ordinary outcome — a Linux entry naming a theme
 * icon, a Windows exe — and the picker shows the name on its own.
 */
function iconsFor(paths) {
  // One scan for the whole set. `sendNativeMessage` starts a fresh process per
  // message, so asking per browser meant re-reading every Info.plist in
  // /Applications once per icon — measured at 1.27s for three.
  const known = new Map(installedBrowsers().map((b) => [b.path, b]));
  const icons = {};
  for (const path of Array.isArray(paths) ? paths : []) {
    const browser = known.get(path);
    if (!browser) continue;
    try {
      if (OS === 'darwin') icons[path] = macIcon(browser.path);
      else if (OS !== 'win32') icons[path] = fileIcon(linuxIconPath(browser.id));
      // Windows keeps the icon inside the .exe, and pulling it out needs a
      // decoder this helper is not going to carry.
    } catch {
      // No icon is an ordinary outcome, and the picker shows the name alone.
    }
  }
  return { ok: true, icons };
}

/** macOS: the bundle's .icns, converted by the tool that ships with it. */
function macIcon(appPath) {
  const res = join(appPath, 'Contents', 'Resources');
  const plist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return '';
  const info = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  const named = macIconFile(info);
  let icns = named ? join(res, named) : '';
  if (!icns || !existsSync(icns)) {
    // Some bundles name no icon at all. One .icns in Resources is still an
    // answer; several is a guess, and no icon beats the wrong one.
    const all = existsSync(res) ? readdirSync(res).filter((f) => f.endsWith('.icns')) : [];
    if (all.length !== 1) return '';
    icns = join(res, all[0]);
  }
  const out = join(tmpdir(), `linkward-icon-${process.pid}.png`);
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '32', icns, '--out', out], {
      stdio: 'ignore',
    });
    return dataUrl(readFileSync(out));
  } finally {
    rmSync(out, { force: true });
  }
}

/** Linux: whatever the .desktop entry points at, if it points at a file. */
function linuxIconPath(id) {
  for (const dir of desktopDirs()) {
    const file = join(dir, `${id}.desktop`);
    if (!existsSync(file)) continue;
    const path = desktopIconPath(readFileSync(file, 'utf8'));
    if (path && existsSync(path)) return path;
  }
  return '';
}

// macOS gets `sips -Z 32`, so its icons are ~3KB. A .desktop entry points at
// whatever is on disk, which can be a 512px PNG, and there is no resizer to
// assume here. Four of those would be megabytes through a native-messaging
// channel for decoration — so an oversized icon is no icon.
const ICON_BYTES_MAX = 256 * 1024;

function fileIcon(path) {
  if (!path) return '';
  if (statSync(path).size > ICON_BYTES_MAX) return '';
  const type = path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  return dataUrl(readFileSync(path), type);
}

function dataUrl(bytes, type = 'image/png') {
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/** Started and let go: this helper exits when Firefox disconnects. */
function detach(command, args) {
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

// --- the stdin frame reader -------------------------------------------------
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      send({ ok: false, why: 'unreadable message' });
      continue;
    }
    if (msg?.type === 'list') send({ ok: true, browsers: installedBrowsers() });
    else if (msg?.type === 'icons') send(iconsFor(msg.paths));
    else if (msg?.type === 'open') send(openIn(msg.path, msg.url));
    else send({ ok: false, why: 'unknown command' });
  }
});
process.stdin.on('end', () => process.exit(0));
