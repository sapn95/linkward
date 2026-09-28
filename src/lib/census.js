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
export function routingState({ enabled, armed, rules, neverAsk, peerRoutes } = {}) {
  const routing = enabled === true && armed === true;
  return { routing, routes: routing ? routeHosts(rules, neverAsk, peerRoutes) : [] };
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
 *
 * `peerRoutes` comes off the same rule and is NOT the same claim. Those hosts
 * are dropped because linkward genuinely releases them now — standsDownFor
 * checks the identical list before anything else — so publishing them would be
 * claiming requests this add-on hands straight back.
 *
 * What must NOT follow from that, and it has been proposed twice: dropping a
 * PEER from the warning because everything it published is covered here. It
 * reads like the same rule applied the other way round, and it is not. What a
 * peer publishes is its RULES; what it acts on is wider. Container commander
 * reopens a tab from a bookmark-folder hint with no rule matched at all
 * (`ruleId: bookmark:…` in its engine), on a host that therefore appears in no
 * route list — so linkward is still asking about that host and the pair
 * survives. Over-warning is the safe direction, which is why clashes() reports
 * a routing peer whether or not anything overlaps.
 */
export function routeHosts(rules, neverAsk, peerRoutes) {
  const out = [];
  for (const [host, rule] of Object.entries(rules ?? {})) {
    if (!host || !rule || typeof rule !== 'object') continue;
    if (rule.plain === true) continue;
    if (!rule.container && !rule.cookieStoreId) continue;
    // matchesAny reads a URL, and a bare host is not one. A rule key that cannot
    // be made into a URL is kept rather than dropped: over-warning is the safe
    // direction, and a host nobody can parse is not one the list can cover.
    const url = `https://${host}/`;
    if (matchesAny(url, neverAsk)) continue;
    // Left to the peer that already routes it — see standsDownFor. Reporting it
    // would be claiming a host this add-on releases untouched, and the reader of
    // that claim is the very add-on the host was handed to.
    if (matchesAny(url, peerRoutes)) continue;
    out.push(host.toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * The hosts a peer is already routing, so linkward can keep out of them.
 *
 * Container commander wins on the hosts it manages. That is the decision, made
 * once and in code rather than offered as a button on two settings pages: when
 * both add-ons act on one request the browser carries out both, and only one of
 * them has to give way for that to stop. The one with a policy file behind it is
 * the one that should not.
 *
 * Only a peer that says `routing: true` counts. A peer that is paused, in a dry
 * run, or missing its host permission cancels nothing, and standing down for it
 * would leave the request to an add-on that has already stood down itself — the
 * mirror-image failure, where a link opens in no container at all and both
 * add-ons report themselves healthy.
 *
 * `rule:<id>` entries are dropped. A regex rule is published as its id rather
 * than its source, so it is a label; keeping it would put a string in the list
 * that no host can ever match, which is harmless and misleading in a list people
 * read off the settings page.
 *
 * @param {Array<object|null>} answers  one cc:ping reply per peer, nulls allowed
 * @returns {string[]} host patterns, deduplicated and sorted
 */
export function peerRouteHosts(answers = []) {
  const out = new Set();
  for (const a of answers) {
    // Everything here crossed an extension boundary this one does not control.
    if (!a || typeof a !== 'object' || a.routing !== true) continue;
    for (const route of Array.isArray(a.routes) ? a.routes : []) {
      if (typeof route !== 'string') continue;
      const host = route.trim().toLowerCase();
      if (!host || host.startsWith('rule:')) continue;
      out.add(host);
    }
  }
  return [...out].sort();
}

/**
 * The peers linkward is currently standing down for.
 *
 * A peer cannot see that it has been given way to. Container commander asks
 * whether linkward is routing, hears yes — it is, on everything the peer did
 * not publish — and raises the same alarm it raised before any of this existed,
 * telling somebody to go and switch one of the two off by hand. The arrangement
 * that already fixed it is invisible, so the warning reads as "nothing worked".
 *
 * Only a peer that contributed a host counts. One that answered `routing: true`
 * with nothing linkward could match has not been given way to in any sense, and
 * saying otherwise would quiet a warning that is still entirely true.
 *
 * @param {Array<object|null>} answers  one cc:ping reply per peer, nulls allowed
 * @returns {string[]} peer ids, deduplicated and sorted
 */
export function deferringTo(answers = []) {
  const out = new Set();
  for (const a of answers) {
    if (!a || typeof a !== 'object' || a.routing !== true) continue;
    if (typeof a.id !== 'string' || !a.id) continue;
    if (peerRouteHosts([a]).length) out.add(a.id);
  }
  return [...out].sort();
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
