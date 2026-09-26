// Who else is routing.
//
// Two extensions that both hold a BLOCKING webRequest listener both get the
// same request, and neither can see the other. If both take it — one cancelling
// and reopening in a container, the other redirecting to a picker, or both
// reopening — the browser carries out both. One click becomes two tabs.
//
// That happened, and it took weeks to find. linkward had `enabled: true` and
// rules pinning seven hosts to a container; container commander was routing a
// wildcard over the same hosts from its managed policy. Every one of those links
// opened in a pair, same address, same container, and NOTHING in either add-on
// could say so — each was doing exactly what it was configured to do, and both
// were right about where those hosts belong. Agreement was the cause, so every
// check either one could run alone came back clean.
//
// The platform offers no listener census: an extension cannot enumerate another
// extension's webRequest listeners, and `management` would need a permission
// whose warning is worse than the bug. So it is asked, over container
// commander's claim protocol, and answered honestly by each participant.
//
// Shared with container-commander, the way candidates.js and focus.js went the
// other way. Keep the COMPARISON functions identical in both — clashes(),
// overlapping(), covers() — because a census where the two sides disagree about
// what overlaps is worse than no census. What each side publishes is its own
// business and already differs: commander reduces a regex rule to its id, and the
// import below is linkward's never-ask list, which commander has no equivalent of.
//
// Pure. No browser APIs — the caller collects the answers and hands them over.

import { matchesAny } from './candidates.js';

/** The add-ons that speak the protocol. A fixed list: no discovery, no relay. */
export const PEERS = ['container-commander@sapn95.github.io', 'beeline@sapn95.github.io'];

/**
 * What linkward answers when a peer asks what it is doing.
 *
 * `routing` means one thing: "a navigation I see right now could be taken away
 * from the tab it was heading for". Both of these have to be true for it, and
 * neither is about the rules:
 *
 *   enabled   the master switch on the options page.
 *   armed     the listener is actually registered — which needs `<all_urls>`,
 *             and the permission can be handed back in the browser's own add-on
 *             settings behind our back.
 *
 * Deliberately NOT conditional on having any rules. With no rule at all linkward
 * still redirects the request to its picker, and a peer that reopens the same
 * request in a container leaves you with the container tab AND a picker asking
 * about a link that has already opened. Two tabs, one of them a question.
 *
 * @param {{enabled?: boolean, armed?: boolean, rules?: object, neverAsk?: string[]}} state
 */
export function routingState({ enabled, armed, rules, neverAsk } = {}) {
  const routing = enabled === true && armed === true;
  return { routing, routes: routing ? routeHosts(rules, neverAsk) : [] };
}

/**
 * The hosts linkward would move to a container, for a human to compare against
 * another add-on's list.
 *
 * A `plain` rule is left out, and that is the point of it: pinned to no
 * container, linkward releases the request untouched, so it cannot be half of a
 * pair. Listing it would put a host in somebody's warning that is not part of
 * the problem — and the hosts that ARE the problem would be harder to see for it.
 *
 * The never-ask list wins over a rule, because that is the order `shouldAsk`
 * applies them in: an excluded host is released before the rules are consulted
 * at all. This matters more than it looks. Putting the shared hosts on that list
 * is the fix this whole warning points people at, and a rule they leave behind
 * would otherwise keep the warning standing on both settings pages after they
 * have done exactly what it asked. `matchesAny` is imported rather than reworded
 * here: a second copy of the suffix rule is a census that disagrees with the
 * decision it is describing.
 */
export function routeHosts(rules, neverAsk) {
  const out = [];
  for (const [host, rule] of Object.entries(rules ?? {})) {
    if (!host || !rule || typeof rule !== 'object') continue;
    if (rule.plain === true) continue;
    if (!rule.container && !rule.cookieStoreId) continue;
    // matchesAny reads a URL, and a bare host is not one. A rule key that cannot
    // be made into a URL is kept rather than dropped: over-warning is the safe
    // direction, and a host nobody can parse is not one the list can cover.
    if (matchesAny(`https://${host}/`, neverAsk)) continue;
    out.push(host.toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * Peers that are also routing.
 *
 * Only ever a clash when BOTH sides are live. One router is the working state,
 * whichever one it is — this must not nag about a peer merely being installed,
 * or it becomes the warning everybody clicks past, and the one time it is real
 * it gets clicked past too.
 *
 * @param {{routing?: boolean, routes?: string[]}} self  this add-on's routingState()
 * @param {Array<object|null>} answers                   one reply per peer, nulls allowed
 * @returns {Array<{id, name, version, routes, overlap}>} worst overlap first
 */
export function clashes(self, answers = []) {
  if (self?.routing !== true) return [];
  const found = [];
  for (const a of answers) {
    // Everything here arrived from another extension's message handler, across a
    // boundary this one does not control. None of it is trusted.
    if (!a || typeof a !== 'object') continue;
    if (a.routing !== true) continue;
    const routes = (Array.isArray(a.routes) ? a.routes : []).filter(
      (r) => typeof r === 'string' && r,
    );
    found.push({
      id: typeof a.id === 'string' ? a.id : '',
      // Both halves of the fallback are filtered, not only the first. A peer that
      // answers `name: ''` would otherwise be reported as nothing at all, and one
      // whose id is not a string would be reported as whatever String() makes of
      // it. The sentence this ends up in has to name something a person can go
      // and find.
      name: displayable(a.name) || displayable(a.id) || 'another extension',
      version: typeof a.version === 'string' ? a.version : '',
      routes,
      overlap: overlapping(self.routes ?? [], routes),
    });
  }
  // The one sharing the most hosts is doing the most damage, and it is the one
  // whose name belongs in a one-line warning.
  return found.sort((a, b) => b.overlap.length - a.overlap.length);
}

/** A field from a peer, if it is a string with something in it. Otherwise ''. */
function displayable(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The patterns two lists agree on.
 *
 * Not set intersection: `*.example.com` and `docs.example.com` are the same
 * jurisdiction written at two widths, and that pair IS the bug this file was
 * written for. Reported under the more specific of the two, because that is the
 * one somebody can search their own settings for.
 */
export function overlapping(mine, theirs) {
  const out = new Set();
  for (const m of mine) {
    for (const t of theirs) {
      if (m === t) out.add(t);
      else if (covers(m, t)) out.add(t);
      else if (covers(t, m)) out.add(m);
    }
  }
  return [...out];
}

/** Does the glob `pattern` cover the literal-or-glob `host`? */
function covers(pattern, host) {
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(1); // '.example.com'
  // The bare apex too: `*.example.com` covers `example.com` in both add-ons.
  return host.endsWith(suffix) || host === pattern.slice(2);
}

/**
 * The warning, in one sentence, or null.
 *
 * Built here rather than in the page so the options page and any later screen
 * cannot drift into saying different things about one fact.
 */
export function clashLine(found = []) {
  if (!found.length) return null;
  const first = found[0];
  const who = [first.name, first.version].filter(Boolean).join(' ');
  const rest = found.length > 1 ? ` (and ${found.length - 1} more)` : '';
  const where = first.overlap.length
    ? ` Both open ${first.overlap.slice(0, 3).join(', ')}${first.overlap.length > 3 ? ', …' : ''}.`
    : '';
  return (
    `${who}${rest} is also deciding where links open.${where}` +
    ' Two add-ons that both take a request open two tabs for it.' +
    ' Switch it off in one of them.'
  );
}
