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

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { macBrowser, desktopBrowser, windowsBrowsers, tidy } from './parse.mjs';

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
        info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
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
function linuxBrowsers() {
  const dirs = [
    join(homedir(), '.local/share/applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    join(homedir(), '.local/share/flatpak/exports/share/applications'),
  ];
  const found = [];
  for (const dir of dirs) {
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
    else if (msg?.type === 'open') send(openIn(msg.path, msg.url));
    else send({ ok: false, why: 'unknown command' });
  }
});
process.stdin.on('end', () => process.exit(0));
