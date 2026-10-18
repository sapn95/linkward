// The browsers a link can be handed to instead of a container.
//
// A Firefox extension cannot start another application. `protocol_handlers`
// only registers Firefox AS a handler and `downloads.open()` uses whatever the
// system default already is, so the list below comes from a native helper over
// `nativeMessaging` — see native/README.md. The permission is OPTIONAL: an
// add-on that demands "exchange messages with programs other than Firefox" at
// install, to do nothing until a helper is also installed, is one nobody keeps.
//
// Pure. No browser APIs: the caller collects the reply and hands it over.

/**
 * The helper's reply, made safe to render.
 *
 * Every field crossed a process boundary. The helper is the user's own, but it
 * reads `Info.plist` files written by whoever shipped the application, so a
 * name is somebody else's string and is treated as one.
 *
 * `path` is required and must be absolute, because it is what gets handed back
 * for the open. An entry without one is an entry that cannot be acted on, and
 * showing a button that silently does nothing is the failure this add-on
 * already has a catalogue entry about.
 */
export function readBrowsers(reply) {
  if (!reply || typeof reply !== 'object' || reply.ok !== true) return [];
  const out = [];
  for (const b of Array.isArray(reply.browsers) ? reply.browsers : []) {
    if (!b || typeof b !== 'object') continue;
    const id = text(b.id);
    const path = text(b.path);
    if (!id || !path.startsWith('/')) continue;
    out.push({ id, path, name: text(b.name) || id });
  }
  // Deduplicated on id, keeping the first: the helper sorts by name, so the
  // first of a pair is the one a reader would have pointed at.
  const seen = new Set();
  return out.filter((b) => !seen.has(b.id) && seen.add(b.id));
}

/**
 * The ones to put on the picker.
 *
 * An empty or absent `show` means ALL of them, and that is not the same as
 * none. A fresh install has chosen nothing, and reading that as "hide
 * everything" would make the feature look broken the moment it is switched on.
 * Hiding all of them is said by switching the feature off.
 *
 * Ids that match nothing installed are dropped in silence. A browser gets
 * uninstalled, and a list that kept naming it would offer a button that cannot
 * work — see readBrowsers above for why that is the one thing to avoid.
 *
 * @param {Array<{id: string}>} browsers  readBrowsers() output
 * @param {{enabled?: boolean, show?: string[]}} settings
 */
export function visibleBrowsers(browsers = [], settings = {}) {
  if (settings?.enabled !== true) return [];
  const show = Array.isArray(settings.show) ? settings.show.filter((s) => text(s)) : [];
  if (!show.length) return browsers;
  const wanted = new Set(show);
  return browsers.filter((b) => wanted.has(b.id));
}

/** A field from the helper, if it is a string with something in it. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
