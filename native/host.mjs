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

import { readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Native messaging frames every message with a 32-bit little-endian length.
// Firefox refuses anything over 1 MB from us; nothing here comes close.
function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

/**
 * Every installed app that declares it can open an http(s) URL.
 *
 * By CAPABILITY and never by a list of known names: a list is wrong the first
 * time somebody installs a browser nobody thought of, and it would take a
 * release to learn one. An app that handles `http` is a browser for this
 * purpose, whatever it calls itself.
 *
 * Firefox itself is excluded. Offering to open a link in the browser the link
 * is already in is a button that does nothing.
 */
function installedBrowsers() {
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
      const schemes = new Set(
        (info.CFBundleURLTypes ?? [])
          .flatMap((t) => t.CFBundleURLSchemes ?? [])
          .map((s) => String(s).toLowerCase()),
      );
      // All three, and `file` is the one that does the work. Measured on a real
      // machine: iTerm2, Hammerspoon and VLC all claim `http` and `https` —
      // Launch Services agrees they are http handlers — and none of them claims
      // `file`. A browser opens a local page too. That is a capability and not
      // a list of names, which is the whole point: a list is wrong the first
      // time somebody installs a browser nobody thought of.
      if (!schemes.has('http') || !schemes.has('https') || !schemes.has('file')) continue;
      const id = info.CFBundleIdentifier;
      if (typeof id !== 'string' || !id) continue;
      if (id.startsWith('org.mozilla.firefox')) continue;
      found.push({
        id,
        name: info.CFBundleName ?? name.replace(/\.app$/, ''),
        path: app,
      });
    }
  }
  // Deduplicated by bundle id: the same browser can sit in both roots, and the
  // user-level copy is the one that was installed deliberately.
  const byId = new Map();
  for (const b of found) if (!byId.has(b.id)) byId.set(b.id, b);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Start a browser on a URL.
 *
 * The URL is checked here and not only in the extension. This process is
 * reachable by anything the browser lets talk to it, and `open` will hand a
 * `file://` or a `javascript:` string straight to the application.
 *
 * `open -a <path>` takes the application by PATH rather than by name: two apps
 * can share a name, and the path is what the list above actually reported.
 */
function openIn(appPath, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, why: 'not a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, why: `refusing ${parsed.protocol}` };
  }
  if (typeof appPath !== 'string' || !appPath.startsWith('/') || !existsSync(appPath)) {
    return { ok: false, why: 'no such application' };
  }
  try {
    if (!statSync(appPath).isDirectory()) return { ok: false, why: 'not an application' };
    // Detached: this helper exits as soon as Firefox disconnects, and a child
    // still attached to its pipes would be killed with it.
    spawn('/usr/bin/open', ['-a', appPath, parsed.href], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e.message ?? e).slice(0, 120) };
  }
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
