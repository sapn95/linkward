// Who else is deciding where links open.
//
// This module exists because of a failure that nothing in either add-on could
// see: linkward pinning seven hosts to a container with interception on, while
// container commander routed a wildcard over the same hosts from its managed
// policy. Two blocking listeners, one request, both of them taking it — and the
// browser carried out both. Every one of those links opened in a pair, for
// weeks, with both add-ons reporting themselves healthy, because an extension
// cannot enumerate another extension's listeners.
//
// So the cases below are not hypotheticals. The first one IS the failure.

import { describe, it, expect } from 'vitest';
import {
  PEERS,
  routingState,
  routeHosts,
  overlapping,
  clashes,
  clashLine,
  peerRouteHosts,
} from '../src/lib/census.js';

const PINNED = { container: 'work', cookieStoreId: 'firefox-container-2' };

const SELF = { routing: true, routes: ['docs.example.com', 'code.example.com'] };

const COMMANDER = {
  id: 'container-commander@sapn95.github.io',
  name: 'container commander',
  version: '0.5.2',
  routing: true,
  routes: ['*.example.com', 'portal.example-cloud.com'],
};

describe('the participants', () => {
  it('is a fixed list that does not include linkward itself', () => {
    // No discovery and no relay: an add-on that asks whoever answers is an
    // add-on any other add-on can put a warning into.
    expect(PEERS).toEqual(['container-commander@sapn95.github.io', 'beeline@sapn95.github.io']);
    expect(PEERS).not.toContain('linkward@sapn95.github.io');
  });
});

describe('what linkward reports about itself', () => {
  it('is routing when it is switched on and the listener is really registered', () => {
    const s = routingState({ enabled: true, armed: true, rules: { 'a.example': PINNED } });
    expect(s.routing).toBe(true);
    expect(s.routes).toEqual(['a.example']);
  });

  // Two states, and in neither of them is a request ever held. Claiming to route
  // would put a warning in a peer's settings page about a pair that cannot happen.
  it.each([
    ['switched off', { enabled: false, armed: true }],
    ['switched on with the access handed back', { enabled: true, armed: false }],
  ])('is not routing when it is %s', (_label, state) => {
    const s = routingState({ ...state, rules: { 'a.example': PINNED } });
    expect(s.routing).toBe(false);
    // And publishes nothing, so a stale route list cannot outlive the routing.
    expect(s.routes).toEqual([]);
  });

  it('is routing with no rules at all, which is the part that surprises people', () => {
    // With nothing remembered linkward still redirects the request to its picker.
    // A peer that reopens the same request in a container leaves you with the
    // container tab AND a picker asking about a link that has already opened.
    const s = routingState({ enabled: true, armed: true, rules: {} });
    expect(s.routing).toBe(true);
    expect(s.routes).toEqual([]);
  });

  it('answers without throwing on no state at all', () => {
    expect(routingState()).toEqual({ routing: false, routes: [] });
  });
});

describe('the hosts it publishes', () => {
  it('names the hosts it would move to a container', () => {
    expect(
      routeHosts({
        'docs.example.com': PINNED,
        'code.example.com': { container: 'work' },
      }),
    ).toEqual(['docs.example.com', 'code.example.com']);
  });

  it('leaves out a host pinned to no container', () => {
    // A plain rule releases the request untouched, so it cannot be half of a
    // pair. Listing it would put a host in somebody's warning that is not part of
    // the problem, and make the ones that are harder to see.
    expect(
      routeHosts({
        'plain.example.com': { container: null, cookieStoreId: '', plain: true },
        'empty.example.com': { container: null, cookieStoreId: '' },
        'real.example.com': PINNED,
      }),
    ).toEqual(['real.example.com']);
  });

  it('lower-cases, because the other side compares strings', () => {
    expect(routeHosts({ 'Docs.Example.COM': PINNED })).toEqual(['docs.example.com']);
  });

  it('skips a malformed entry rather than publishing a blank', () => {
    // These rules come out of synced storage, which another machine wrote.
    expect(routeHosts({ '': PINNED, 'a.example': null, 'b.example': 'yes' })).toEqual([]);
    expect(routeHosts()).toEqual([]);
  });

  it('leaves out a host the never-ask list already releases', () => {
    // This is the remediation path the warning itself points at, so it has to be
    // the one that works: somebody puts the shared hosts on the never-ask list
    // and leaves the rules alone. shouldAsk releases an excluded host before it
    // reads any rule, so the rule that is still there decides nothing — and a
    // warning that survives doing what it asked is worse than no warning.
    expect(
      routeHosts({ 'docs.example.com': PINNED, 'code.example.com': PINNED }, ['docs.example.com']),
    ).toEqual(['code.example.com']);
  });

  it('honours the never-ask list the way the decision reads it, wildcards and all', () => {
    // matchesAny strips a leading `*.` and matches on a label boundary, so one
    // entry can cover every rule underneath it. Re-deriving that here instead of
    // calling it would let the census drift from the decision it describes.
    expect(
      routeHosts({ 'docs.example.com': PINNED, 'code.example.com': PINNED }, ['example.com']),
    ).toEqual([]);
    expect(routeHosts({ 'docs.example.com': PINNED }, ['*.example.com'])).toEqual([]);
    // and a suffix that is not a boundary is not covered
    expect(routeHosts({ 'notexample.com': PINNED }, ['example.com'])).toEqual(['notexample.com']);
  });

  it('keeps a rule key that cannot be read as a host, rather than dropping it', () => {
    // Over-warning is the safe direction. A key no URL parser accepts is not one
    // the never-ask list can cover either, so silence about it would be a guess.
    expect(routeHosts({ 'not a host': PINNED }, ['example.com'])).toEqual(['not a host']);
  });

  it('passes the never-ask list through routingState, not just routeHosts', () => {
    // The wiring is the half that goes missing: routeHosts can be correct while
    // the caller never hands it the list.
    expect(
      routingState({
        enabled: true,
        armed: true,
        rules: { 'docs.example.com': PINNED, 'code.example.com': PINNED },
        neverAsk: ['docs.example.com'],
      }),
    ).toEqual({ routing: true, routes: ['code.example.com'] });
  });
});

describe('the overlap between two host lists', () => {
  it('sees a wildcard and a bare host as the same jurisdiction', () => {
    // NOT set intersection. `*.example.com` and `docs.example.com` never compare
    // equal, and that pair is the entire failure.
    expect(overlapping(['docs.example.com'], ['*.example.com'])).toEqual(['docs.example.com']);
  });

  it('reads the pair the same way round', () => {
    expect(overlapping(['*.example.com'], ['docs.example.com'])).toEqual(['docs.example.com']);
  });

  it('counts the apex as covered by its own wildcard', () => {
    expect(overlapping(['example.com'], ['*.example.com'])).toEqual(['example.com']);
  });

  it('does not match a suffix that is not a label boundary', () => {
    expect(overlapping(['notexample.com'], ['*.example.com'])).toEqual([]);
  });

  it('finds nothing between two unrelated lists', () => {
    expect(overlapping(['a.example'], ['b.example'])).toEqual([]);
  });
});

describe('finding the add-ons that are also routing', () => {
  it('reports a peer whose wildcard covers the remembered hosts', () => {
    const found = clashes(SELF, [COMMANDER]);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('container commander');
    expect(found[0].overlap).toEqual(['docs.example.com', 'code.example.com']);
  });

  it('says nothing about a peer that is installed but not routing', () => {
    // One router is the working state, whichever one it is. A warning that fires
    // on a peer merely being installed is the warning everybody clicks past — and
    // then the one time it is real, it gets clicked past too.
    expect(clashes(SELF, [{ ...COMMANDER, routing: false }])).toEqual([]);
  });

  it('says nothing when linkward is the one not routing', () => {
    expect(clashes({ routing: false, routes: [] }, [COMMANDER])).toEqual([]);
    expect(clashes(undefined, [COMMANDER])).toEqual([]);
  });

  it('still reports a routing peer with nothing in common', () => {
    // Overlap is what makes it visible, not what makes it true: linkward asks
    // about every external link, not only the remembered ones, so two add-ons can
    // collide on a host neither of them published.
    const found = clashes(SELF, [{ ...COMMANDER, routes: ['nowhere.example'] }]);
    expect(found).toHaveLength(1);
    expect(found[0].overlap).toEqual([]);
  });

  it('puts the worst overlap first', () => {
    const small = { ...COMMANDER, name: 'small', routes: ['code.example.com'] };
    expect(clashes(SELF, [small, COMMANDER]).map((f) => f.name)).toEqual([
      'container commander',
      'small',
    ]);
  });

  // Every one of these arrives from another extension's message handler, across a
  // boundary linkward does not control. None of it is trusted.
  it.each([
    ['a peer that did not answer', null],
    ['a timeout', undefined],
    ['a string', 'yes'],
    ['a reply with no routing field', { name: 'x' }],
  ])('ignores %s', (_label, answer) => {
    expect(clashes(SELF, [answer])).toEqual([]);
  });

  it('falls back to the id, then to a generic name, when a peer names itself badly', () => {
    // A peer answering without a name still has to be reportable: the whole point
    // is telling somebody WHICH add-on to go and switch off.
    const [byId] = clashes(SELF, [{ id: 'beeline@sapn95.github.io', routing: true }]);
    expect(byId.name).toBe('beeline@sapn95.github.io');
    expect(byId.version).toBe('');

    const [anon] = clashes(SELF, [{ routing: true }]);
    expect(anon.name).toBe('another extension');
    expect(anon.id).toBe('');
  });

  it('does not report a blank or a non-string as the add-on to go and switch off', () => {
    // An empty name passed the old string check and came out as nothing at all,
    // and an id that is not a string came out as whatever String() makes of it.
    // The sentence has to name something somebody can find in their add-ons list.
    const [blank] = clashes(SELF, [{ name: '   ', id: 'beeline@sapn95.github.io', routing: true }]);
    expect(blank.name).toBe('beeline@sapn95.github.io');

    for (const bad of [{ id: 42 }, { id: {} }, { id: '' }, { name: '', id: null }]) {
      const [found] = clashes(SELF, [{ ...bad, routing: true }]);
      expect(found.name).toBe('another extension');
      expect(found.id).toBe('');
    }
  });

  it('compares against an empty route list of its own without throwing', () => {
    // routingState() reports routing with no rules at all, on purpose.
    const [found] = clashes({ routing: true }, [COMMANDER]);
    expect(found.overlap).toEqual([]);
  });

  it('survives a reply whose routes are not a list of strings', () => {
    const found = clashes(SELF, [{ ...COMMANDER, routes: [1, null, 'docs.example.com'] }]);
    expect(found[0].routes).toEqual(['docs.example.com']);
  });
});

describe('the sentence it puts on screen', () => {
  it('names the add-on, the shared hosts and what to do', () => {
    const line = clashLine(clashes(SELF, [COMMANDER]));
    expect(line).toContain('container commander 0.5.2');
    expect(line).toContain('docs.example.com');
    expect(line).toContain('two tabs');
    expect(line).toContain('Switch it off in one of them.');
  });

  it('truncates a long shared list rather than filling the box with it', () => {
    const self = {
      routing: true,
      routes: ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com'],
    };
    const line = clashLine(clashes(self, [COMMANDER]));
    expect(line).toContain('a.example.com, b.example.com, c.example.com, …');
    expect(line).not.toContain('d.example.com');
  });

  it('drops the version when the peer did not send one', () => {
    expect(clashLine(clashes(SELF, [{ name: 'beeline', routing: true }]))).toMatch(
      /^beeline is also deciding/,
    );
  });

  it('counts the others when more than one is routing', () => {
    const other = { id: 'b@x', name: 'beeline', routing: true, routes: ['code.example.com'] };
    expect(clashLine(clashes(SELF, [COMMANDER, other]))).toContain('(and 1 more)');
  });

  it('is null when nothing clashes, so a page can test it directly', () => {
    expect(clashLine([])).toBeNull();
    expect(clashLine()).toBeNull();
  });
});

// Container commander wins on the hosts it manages, and linkward gives way
// without being asked. This is the list that decision is made from, so every
// case here is a way of standing down for the wrong reason — or of failing to.
describe('the hosts a peer has already taken', () => {
  const ROUTING = { routing: true, routes: ['docs.example.com', '*.example.org'] };

  it('takes the routes of a peer that is really routing', () => {
    expect(peerRouteHosts([ROUTING])).toEqual(['*.example.org', 'docs.example.com']);
  });

  it('ignores a peer that cancels nothing', () => {
    // Paused, dry run, or missing its host permission. Standing down for it
    // would hand the link to an add-on that has already stood down itself, and
    // it opens in no container at all — the same bug from the other side.
    expect(peerRouteHosts([{ ...ROUTING, routing: false }])).toEqual([]);
    expect(peerRouteHosts([{ ...ROUTING, routing: undefined }])).toEqual([]);
  });

  it('drops a rule id, which no host can ever match', () => {
    expect(peerRouteHosts([{ routing: true, routes: ['rule:msal', 'a.example.com'] }])).toEqual([
      'a.example.com',
    ]);
  });

  it('merges the peers into one list, lowercased and without repeats', () => {
    expect(
      peerRouteHosts([
        { routing: true, routes: ['B.example.com'] },
        { routing: true, routes: ['b.example.com', 'a.example.com'] },
      ]),
    ).toEqual(['a.example.com', 'b.example.com']);
  });

  it('answers with an empty list rather than throwing on junk', () => {
    // A silent peer is a null, and every field here crossed a boundary this
    // extension does not control. Empty means linkward asks, which is what it
    // did before any of this existed.
    expect(peerRouteHosts()).toEqual([]);
    expect(peerRouteHosts([null, 'nope', { routing: true }, { routing: true, routes: 7 }])).toEqual(
      [],
    );
    expect(peerRouteHosts([{ routing: true, routes: [42, '', '  '] }])).toEqual([]);
  });
});

describe('what linkward publishes once a peer has taken a host', () => {
  const RULES = {
    'docs.example.com': { container: 'Work' },
    'own.example.net': { container: 'W' },
  };

  it('leaves out what the peer already routes, because it releases those', () => {
    // Claiming a host it hands straight back would be a claim read by the very
    // add-on the host was handed to.
    expect(routeHosts(RULES, [], ['*.example.com'])).toEqual(['own.example.net']);
  });

  it('publishes everything again once the peer stops routing it', () => {
    expect(routeHosts(RULES, [], [])).toEqual(['docs.example.com', 'own.example.net']);
  });
});
