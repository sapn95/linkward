// The parsing the helper does, separated from the machine it runs on.
//
// The helper claims macOS, Linux and Windows. It can only ever be run on one of
// them at a time, so the part that decides what counts as a browser is here,
// takes text instead of a filesystem, and is tested against fixtures from all
// three. Anything that touches disk or spawns a process stays in host.mjs.

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * A browser from a macOS `Info.plist`, already converted to JSON.
 *
 * It qualifies on `http`, `https` AND `file`. The third one does the work, and
 * it was measured rather than assumed: iTerm2, Hammerspoon and VLC all claim
 * the first two, and Launch Services agrees they are http handlers. None of
 * them claims `file`. A browser opens a local page too.
 *
 * @returns {{id, name, path}|null}
 */
export function macBrowser(info, appPath, fallbackName) {
  if (!info || typeof info !== 'object') return null;
  const schemes = new Set(
    (Array.isArray(info.CFBundleURLTypes) ? info.CFBundleURLTypes : [])
      .flatMap((t) => (Array.isArray(t?.CFBundleURLSchemes) ? t.CFBundleURLSchemes : []))
      .map((s) => String(s).toLowerCase()),
  );
  if (!schemes.has('http') || !schemes.has('https') || !schemes.has('file')) return null;
  const id = text(info.CFBundleIdentifier);
  if (!id || isFirefox(id)) return null;
  return { id, name: text(info.CFBundleName) || text(fallbackName) || id, path: text(appPath) };
}

/**
 * A browser from a Linux `.desktop` entry.
 *
 * The same idea in the shape the desktop uses: `text/html` is the local-page
 * capability that `file` is on macOS, and it is what separates a browser from a
 * terminal or a media player that also claims the two scheme handlers.
 *
 * @returns {{id, name, path}|null}
 */
export function desktopBrowser(body, id) {
  // The [Desktop Entry] group only. A file can carry extra action groups, and
  // their Exec lines are not the one that opens a URL.
  const entry = text(body)
    .split(/^\[/m)
    .find((s) => s.startsWith('Desktop Entry'));
  if (!entry) return null;
  const field = (key) => entry.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  // Semicolon-separated, so each type is matched whole: `http` must not be
  // found inside `https`, and `text/html` must not match something longer.
  const mime = new Set(
    field('MimeType')
      .toLowerCase()
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!mime.has('x-scheme-handler/http')) return null;
  if (!mime.has('x-scheme-handler/https')) return null;
  if (!mime.has('text/html')) return null;
  if (field('NoDisplay').toLowerCase() === 'true') return null;
  if (isFirefox(id) || isFirefox(field('Name'))) return null;
  // Field codes are placeholders a launcher substitutes. The URL is appended
  // when the browser is started, so they are stripped rather than filled.
  const exec = field('Exec')
    .replace(/%[uUfFdDnNickvm]/g, '')
    .trim();
  if (!exec) return null;
  return { id: text(id), name: field('Name') || text(id), path: exec };
}

/**
 * The browsers Windows itself knows about.
 *
 * `StartMenuInternet` is where a browser registers to be offered as an internet
 * client, so reading it IS the capability check: an application not registered
 * there is not a browser as far as the system is concerned.
 *
 * @param {string} keys        `reg query …\StartMenuInternet` output
 * @param {(key: string, value: string) => string} read  one registry value
 */
export function windowsBrowsers(keys, read) {
  const out = [];
  for (const line of text(keys).split(/\r?\n/)) {
    const key = line.trim();
    if (!/\\StartMenuInternet\\[^\\]+$/i.test(key)) continue;
    const id = key.split('\\').pop();
    if (!id || isFirefox(id)) continue;
    const command = regValue(read(`${key}\\shell\\open\\command`));
    // Quoted or not, and the two are different problems. Quoted is the normal
    // case because a Windows path has spaces in it, and the switches come
    // after the closing quote. Unquoted, the first space ends the path —
    // Windows requires the quotes when it does not.
    const path = command.startsWith('"')
      ? text(command.slice(1).split('"')[0])
      : text(command.split(/\s+/)[0]);
    if (!path) continue;
    const name = regValue(read(key)) || id;
    if (isFirefox(name)) continue;
    out.push({ id, name, path });
  }
  return out;
}

/** The default value out of a `reg query … /ve` block. */
function regValue(output) {
  return text(text(output).match(/REG_[A-Z_]+\s+(.*)$/m)?.[1]);
}

/**
 * Offering to open a link in the browser it is already in is a button that
 * does nothing, so Firefox is left out wherever its name or id appears.
 */
function isFirefox(value) {
  return /firefox/i.test(text(value));
}

/**
 * The icon file a macOS bundle names, as a file name.
 *
 * `CFBundleIconFile` is allowed to leave the extension off — Safari ships
 * `AppIconUpdated` and Chrome ships `app.icns`, both legal — so the suffix is
 * added when it is missing rather than assumed either way.
 *
 * A NAME, and anything else is refused. The value comes out of a third party's
 * Info.plist and is about to be joined onto a path the helper then reads and
 * hands to the browser. `../../..` in there would read a file somewhere else
 * entirely, and a bundle has no reason to name one: the key means a file in
 * its own Resources directory.
 *
 * @returns {string} a file name, or '' when the bundle names none or names a path
 */
export function macIconFile(info) {
  const named = text(info?.CFBundleIconFile);
  if (!named || /[/\\]/.test(named) || named.startsWith('.')) return '';
  return named.toLowerCase().endsWith('.icns') ? named : `${named}.icns`;
}

/**
 * The icon a .desktop entry names.
 *
 * Only an absolute path is usable here. The freedesktop spec also allows a
 * bare theme name, which would mean walking the icon theme to resolve — a
 * search this helper has no business doing, and whose failure would be a
 * broken image rather than no image.
 *
 * @returns {string} an absolute path, or '' when it is a theme name
 */
export function desktopIconPath(body) {
  const entry = text(body)
    .split(/^\[/m)
    .find((s) => s.startsWith('Desktop Entry'));
  if (!entry) return '';
  const icon = text(entry.match(/^Icon=(.*)$/m)?.[1]);
  return icon.startsWith('/') ? icon : '';
}

/** One list, deduplicated and in reading order. */
export function tidy(found) {
  const byId = new Map();
  for (const b of found) if (b?.id && !byId.has(b.id)) byId.set(b.id, b);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
