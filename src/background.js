// The interception.
//
// A link handed to the browser by another application should not open before
// the user has said where. Firefox lets an extension stop a top-level request
// BEFORE it is sent, so nothing is fetched, no cookie is set, and no session is
// created in the wrong container. Chrome MV3 removed that ability, so the Chrome
// build can only turn the tab around after the navigation has started — see
// docs/architecture.md for what that costs.
//
// Everything here is off until the user switches it on: the permissions this
// needs (`<all_urls>` above all) are requested from the options page and can be
// handed back, and no listener is registered while they are absent.

import {
  shouldAsk,
  isCandidateTab,
  matchesAny,
  startedInsideBrowser,
  transitionIsInternal,
} from './lib/candidates.js';
import { noteFocusChange, readFocusState, seedFocusState } from './lib/focus.js';
import { isFirefox, listContainers, resolveRule, hasWatchPermissions } from './lib/containers.js';
import { getSettings, getRules, setRule, removeRule, setRules } from './lib/storage.js';
import { RULE_MESSAGES } from './lib/rules-client.js';
import { PEERS, routingState, clashes, clashLine, peerRouteHosts } from './lib/census.js';

const PICK_PAGE = 'pick/pick.html';
// How long to wait for a peer to answer a ping. Generous next to anything in a
// blocking listener, because nothing is being held up: this runs when a settings
// page opens, and the alternative to waiting is reporting "nobody else is
// routing" because an event page was asleep.
const PING_TIMEOUT_MS = 2000;
// How long after a tab appears its first navigation still counts as the one the
// tab was created for. Long enough for a slow hand-off from another app, short
// enough that ordinary browsing in that tab is never touched.
const FRESH_MS = 5000;

// How long a peer's route list is believed before it is asked for again. The
// list changes when somebody edits a policy file, which is rare and never
// urgent, and the cost of being a few minutes behind is one question asked that
// did not need asking — not a link opening in the wrong place.
const PEER_ROUTES_TTL_MS = 5 * 60 * 1000;

// The hosts container commander is already routing, which linkward leaves to it.
//
// Cached, and it has to be: the decision below runs inside a listener that is
// holding somebody's request open, and asking two other extensions there would
// put a cross-extension round trip in front of every link. So it is refreshed
// out of band — at startup, whenever a settings page takes a census, and after
// the decision that noticed the list had gone stale — and only ever read on the
// path that matters.
//
// Empty is the safe value. It means linkward asks, which is what it did before
// any of this existed.
let peerRoutes = [];
let peerRoutesAt = 0;

// tabId -> when it was flagged. A Map, not storage: this is per-session state
// and a worker restart should forget it rather than ask about a stale tab.
const candidates = new Map();
// Tabs linkward opened itself. Without this the picker's own "open it" would be
// intercepted and we would ask about our own answer, for ever.
const ours = new Set();
// The tabs linkward is in the middle of opening, by the address each was given:
// url -> how many are outstanding for it.
//
// A plain counter was not enough. tabs.onCreated fires before tabs.create
// resolves, so the claim has to be staked before the id is known — but "the
// next tab to appear" also claims a genuinely EXTERNAL link that arrives in
// that same moment, and that link is then never asked about. Two remembered
// links at once had the mirror problem: one finishing cancelled the other's
// claim. Matching on the address the tab was opened with costs nothing and only
// ever claims a tab we asked for.
const pending = new Map();

function claim(url) {
  pending.set(url, (pending.get(url) ?? 0) + 1);
}

function release(url) {
  const left = (pending.get(url) ?? 0) - 1;
  if (left > 0) pending.set(url, left);
  else pending.delete(url);
}

/** Was this tab opened by us, for this address? Consumes the claim if so. */
function claimed(tab) {
  // pendingUrl as well as url: which of the two carries the address a tab was
  // created with differs between the browsers, and between versions of each.
  for (const url of [tab?.url, tab?.pendingUrl]) {
    if (url && pending.has(url)) {
      release(url);
      return true;
    }
  }
  return false;
}

chrome.tabs.onCreated.addListener((tab) => {
  if (claimed(tab)) {
    ours.add(tab.id);
    return;
  }
  if (isCandidateTab(tab, { openedByUs: ours.has(tab.id) })) {
    candidates.set(tab.id, Date.now());
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  candidates.delete(tabId);
  ours.delete(tabId);
});

/**
 * Shared by both browsers. Answers one of:
 *   null            leave it alone
 *   {pick: url}     hand the tab to the picker
 *   {open: id}      the user already answered for this host — open it there
 *   {open: ''}      …and their answer was "with no container", so let it run
 */
async function decide(details) {
  // Storage can reject. Unhandled, that becomes a rejected promise returned
  // straight to a BLOCKING webRequest listener — the one place in this
  // extension where a thrown error is holding up somebody's page.
  const settings = await getSettings().catch(() => null);
  if (!settings?.enabled) return null;
  const ask = shouldAsk(details, {
    candidateSince: (id) => candidates.get(id),
    isExcluded: (url) => matchesAny(url, settings.neverAsk),
    freshMs: FRESH_MS,
  });
  if (!ask) return null;
  // Container commander manages this host, so linkward releases the request
  // untouched and asks nothing. Both add-ons acting on one request is what makes
  // the browser open two tabs for it, and this is the side that gives way.
  //
  // After shouldAsk rather than inside it: shouldAsk answers "is this a link
  // handed over from outside", which is still true here. This is a different
  // question with a different answer — somebody else has it — and folding the
  // two together would make a released request indistinguishable from one that
  // was never ours.
  if (standsDownFor(details.url)) return null;
  // Read before the flag goes: the picker shows it, and nothing else knows it.
  const since = candidates.get(details.tabId);
  // Answered once per tab: the picker's own navigation must not come back here.
  // Before the check below, not after — a tab that has been decided about is
  // decided about, whichever way it went.
  candidates.delete(details.tabId);

  // A bookmark, or an address typed into a new tab. Indistinguishable from a
  // hand-off in everything webRequest and webNavigation carry, so what is asked
  // instead is whether the browser was ALREADY in front when the tab appeared —
  // see startedInsideBrowser. Measured at `since`, the moment the tab was
  // created, because by now the browser is in front either way.
  if (!settings.askInternal) {
    // The browser's own answer first, where there is one. On Chromium this
    // comes from onCommitted and is exact, so nothing below it runs: adding the
    // proxy on top could only suppress a hand-off the browser had already
    // named as one.
    const told = transitionIsInternal(details);
    if (told !== undefined) {
      if (told) return null;
    } else {
      // Firefox, before the request is sent. No transition data exists yet, so
      // this falls back to asking who brought the browser to the front.
      //
      // readFocusState answers `{}` rather than rejecting, on purpose and with
      // a test of its own: this is inside a blocking listener, and a rejection
      // here would be holding up somebody's page.
      const focus = await readFocusState();
      if (startedInsideBrowser(focus, { at: since ?? Date.now() })) return null;
    }
  }

  // A remembered host is the whole point of the tick box on the picker, and
  // until now nothing read these back — the box wrote a rule that was never
  // consulted, so it promised something that did not happen.
  const remembered = await rememberedFor(details.url);
  if (remembered !== undefined) return { open: remembered };

  const target = new URL(chrome.runtime.getURL(PICK_PAGE));
  target.searchParams.set('url', details.url);
  if (since !== undefined) target.searchParams.set('age', String(Date.now() - since));
  return { pick: target.toString() };
}

/** The container this host was pinned to, '' for none, undefined for "ask". */
async function rememberedFor(url) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
  const rules = await getRules().catch(() => ({}));
  const rule = rules[host];
  if (!rule) return undefined;
  // Before the query, not after: a plain rule needs no containers, and this
  // runs inside a blocking handler holding up a request that is about to be
  // released untouched anyway.
  if (rule.plain) return '';
  return resolveRule(rule, await listContainers());
}

/**
 * Open `url` in `cookieStoreId` and take the tab that was heading there away.
 *
 * The claim exists because tabs.onCreated fires before tabs.create resolves:
 * recognising the new tab only afterwards is a race, and its loser is an
 * endless loop of linkward asking about its own answer.
 */
async function openThere(tabId, url, cookieStoreId) {
  claim(url);
  let created;
  try {
    created = await chrome.tabs.create({ url, active: true, cookieStoreId });
  } catch {
    // The container went away between resolving the rule and acting on it. The
    // original request is already cancelled, so put the picker in that tab
    // rather than leave a blank one and no explanation.
    release(url);
    const target = new URL(chrome.runtime.getURL(PICK_PAGE));
    target.searchParams.set('url', url);
    await chrome.tabs.update(tabId, { url: target.toString() }).catch(() => {});
    return;
  }
  // The id is known from here on, so the claim has done its job either way.
  // Released by ADDRESS: a concurrent open for a different link keeps its own,
  // where a shared counter cancelled it and that tab was then flagged a
  // candidate and intercepted as if somebody else had opened it.
  release(url);
  if (typeof created?.id === 'number') {
    ours.add(created.id);
    candidates.delete(created.id);
  }
  // Closing the old tab is tidying up, and it is SEPARATE on purpose: the link
  // is already open in the right container by now, so a failure here must not
  // fall into the branch above and put a picker on top of a page that opened
  // perfectly well.
  if (typeof tabId === 'number' && tabId >= 0) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

// --- Firefox: stop it before the request is sent ---------------------------

// Did the blocking listener actually get registered? Not the same question as
// whether the user switched linkward on: the permission it needs can be handed
// back in the browser's own add-on settings, in which case the switch still says
// on and no request is ever held. Only the census reads this.
let listening = false;

/**
 * Registered SYNCHRONOUSLY, at the top of this file, and that is the whole
 * point.
 *
 * The MV3 background is an event page: the browser is free to shut it down
 * while it is idle and to start it again when something it listens for happens.
 * Only listeners added during the first, synchronous run of the script count as
 * ones it can be started FOR. A listener added after an `await` — on a
 * permission check, say — is invisible to that machinery, so once the page has
 * idled out nothing wakes it, and every link opens straight through.
 *
 * Which is exactly what happened: it worked immediately after loading the
 * add-on and then quietly stopped, with no error anywhere.
 *
 * So the call is attempted at once and allowed to throw. Without the optional
 * permissions there is no `chrome.webRequest` to add to, and that is not a
 * failure — it is a fresh install. `permissions.onAdded` tries again the moment
 * the user grants them, and from then on the listener survives.
 */
function armFirefox() {
  if (!isFirefox()) return;
  try {
    if (!chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) {
      chrome.webRequest.onBeforeRequest.addListener(
        onBeforeRequest,
        { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
        ['blocking'],
      );
    }
    // Recorded because a peer asks. Whether this line was reached is the only
    // thing in the extension that knows the difference between "switched on" and
    // "switched on and actually holding requests" — see the census.
    listening = true;
  } catch {
    // No permission yet. permissions.onAdded will bring us back here.
    listening = false;
  }
}

// Returns a promise, which Firefox honours for blocking listeners. The request
// stays suspended until it resolves, which is what makes "nothing was fetched"
// true rather than a hope.
function onBeforeRequest(details) {
  return decide(details).then((action) => {
    if (!action) return {};
    if (action.pick) return { redirectUrl: action.pick };
    // A remembered host, pinned to no container: that IS the answer, and the
    // request it was about is already the right one. Let it run untouched.
    if (!action.open) return {};
    // Pinned to a container. A redirect cannot change which cookie store a tab
    // belongs to, so the only way is a new tab — and the original request must
    // be cancelled, not redirected, or the page loads in the wrong one first.
    openThere(details.tabId, details.url, action.open);
    return { cancel: true };
  });
}

// --- Chrome: wait for the browser to say how the navigation started --------
//
// This listens to onCommitted, NOT onBeforeNavigate, and that is a deliberate
// trade rather than an oversight.
//
// onBeforeNavigate is earlier and carries no `transitionType`, so the Chrome
// build had to guess whether a new tab was a hand-off or the address bar — and
// it guessed wrong in the one case that matters most: copy a link somewhere,
// switch to the browser, paste. That is a tab created seconds after the browser
// came to the front, which is exactly what a hand-off looks like from outside.
// No amount of tuning separates the two, because nothing before the request
// distinguishes them.
//
// onCommitted carries `transitionType` and `transitionQualifiers`, and with
// them the answer is not a guess at all. The cost is that the navigation has
// committed by the time linkward acts, so the page can flash. On this browser
// that costs less than it sounds: MV3 removed blocking webRequest, so nothing
// here could ever hold the request back — the old listener only ever raced it.
//
// Synchronous for the usual reason: a service worker is stopped when idle and
// restarted for its listeners, and only the ones registered on the first run
// can restart it.
function armChrome() {
  if (isFirefox()) return;
  try {
    if (chrome.webNavigation.onCommitted.hasListener(onCommitted)) return;
    chrome.webNavigation.onCommitted.addListener(onCommitted);
  } catch {
    // Same as above: no webNavigation permission yet.
  }
}

async function onCommitted(details) {
  if (details.frameId !== 0) return;
  // webNavigation gives no originUrl, so the document check in shouldAsk cannot
  // apply. The candidate flag, the freshness window and the transition carry it
  // here instead.
  const action = await decide({ ...details, type: 'main_frame' });
  // Chrome has no containers, so a rule can only ever resolve to "no container"
  // here — which means letting the navigation it already started carry on.
  // Caught, because nothing else can be: webNavigation listeners are not
  // blocking, so this promise is dropped by the dispatcher, and tabs.update
  // rejects whenever the tab closed or moved on between the event and now.
  if (action?.pick) {
    chrome.tabs.update(details.tabId, { url: action.pick }).catch(() => {});
  }
}

// --- Who brought the browser to the front ----------------------------------
//
// The only thing knowable before a request that separates a link handed over by
// another application from a bookmark, a typed address or an address-bar
// search. Needs no permission on either browser, so it is armed unconditionally
// — and synchronously, for the same reason as everything else above.
function onFocusChanged(windowId) {
  // Returned rather than dropped: the browser keeps an event page alive for a
  // promise a listener gives back, and this one has a write in it.
  return noteFocusChange(windowId);
}

function armFocus() {
  // Firefox only, now that Chromium answers the question outright at
  // onCommitted. It is not free: every listener here is one the browser starts
  // the background page FOR, so keeping it on Chromium would wake a service
  // worker on every switch between applications to record something nothing
  // reads any more.
  if (!isFirefox()) return;
  try {
    if (!chrome.windows.onFocusChanged.hasListener(onFocusChanged)) {
      chrome.windows.onFocusChanged.addListener(onFocusChanged);
    }
  } catch {
    // No windows to focus — Firefox for Android, among others. The rule that
    // reads this then never fires, and linkward asks exactly as it did before.
  }
  // Deliberately NOT awaited. arm() has to stay synchronous or the listeners it
  // registers stop being ones the event page can be started for, which is the
  // bug this whole file is arranged around.
  seedFocusState().catch(() => {});
}

function arm() {
  armFirefox();
  armChrome();
  armFocus();
  // Fire and forget, and it must stay that way: arm() runs before any await on
  // purpose, so that the blocking listener is registered before the first
  // request arrives. Awaiting a peer here would put a two-second timeout in
  // front of that.
  refreshPeerRoutes();
}

// Before anything else, and before any await: see armFirefox().
arm();

chrome.runtime.onInstalled.addListener((details) => {
  arm();
  // Everything here needs a permission the browser will only grant on a click,
  // so a fresh install does nothing at all until someone finds the options page
  // and switches it on. Nobody goes looking for a settings page for an
  // extension that has never done anything: the first impression is a link
  // opening exactly as it always did, which reads as broken. So open the page
  // once, on install, and let it explain itself.
  if (details?.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(arm);

// The toolbar button opens the settings in a TAB, not in a popup.
//
// It was a popup, and a popup is a few hundred pixels wide: this page has a
// list of remembered hosts, a dropdown, a textarea and an import/export row,
// and every one of them was folded into a column too narrow to read. A page
// built for a tab belongs in a tab. Removing `default_popup` from the manifest
// is what routes the click here.
chrome.action?.onClicked?.addListener(() => {
  // Caught, because nothing else can be: an onClicked listener's promise is
  // dropped by the dispatcher, and openOptionsPage rejects if the tab cannot be
  // made. An unhandled rejection in an event page is noise nobody sees and a
  // wake-up nobody asked for.
  chrome.runtime.openOptionsPage().catch(() => {});
});
// The only one that really matters after the first run: this is the moment the
// permission arrives and `chrome.webRequest` becomes something we can add to.
chrome.permissions.onAdded.addListener(arm);

// --- Who else is deciding where links open ---------------------------------
//
// linkward is not the only add-on that can take a request away from the tab it
// was heading for, and when two of them do it to the same request the browser
// carries out both: one click, two tabs. Neither add-on malfunctions and neither
// can see the other — the platform has no way to list another extension's
// webRequest listeners. So it is asked. See lib/census.js for what that cost.
//
// Firefox only, and not for tidiness: this failure needs a request that can be
// cancelled before it is sent, which is the ability Chrome MV3 removed. On
// Chrome linkward turns a tab around after the navigation has committed, and a
// second add-on doing the same is a fight over one tab rather than a second tab.

/**
 * What linkward answers a peer with.
 *
 * `hasWatchPermissions` is asked rather than trusting the stored switch, because
 * the tick on the options page can be on while the permission behind it has been
 * handed back in the browser's own add-on settings. Claiming to route in that
 * state would put a warning about linkward into somebody ELSE's settings page for
 * a listener that is not registered.
 *
 * A failed read is NOT caught here: coming back as `enabled: false` inside an
 * otherwise ordinary-looking answer is the one thing this must not do. Both
 * callers already have a "says nothing" reply, and it is the right one for a
 * storage error and for a census that could not run alike.
 */
async function myRoutingState() {
  const [settings, rules, granted] = await Promise.all([
    getSettings(),
    getRules(),
    hasWatchPermissions(),
  ]);
  return routingState({
    enabled: settings?.enabled === true,
    armed: listening && granted,
    rules,
    neverAsk: settings?.neverAsk,
    // The cache, never a fresh ping. This function answers a peer's cc:ping, and
    // pinging back from inside that would have two extensions waiting on each
    // other for an answer neither can give until the other does.
    peerRoutes,
  });
}

/**
 * Answer container commander's `cc:ping`.
 *
 * `sender.id` is assigned by the browser, so it can be trusted, and anything not
 * on the list is ignored in silence rather than refused: other extensions are
 * allowed to exist and to talk to whoever they like.
 *
 * Registered synchronously, like every other listener here, or the event page
 * cannot be started for it and a ping to a sleeping linkward goes unanswered —
 * which reads as "linkward is not routing" and is the one wrong answer this
 * whole mechanism exists to avoid.
 */
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!PEERS.includes(sender?.id)) return undefined;
  if (msg?.type !== 'cc:ping') return undefined;
  myRoutingState().then(
    (state) => sendResponse({ id: chrome.runtime.id, name: 'linkward', ...state }),
    // A reply that omits `routing` is read as "not routing" by the other side,
    // which is the safe way to fail: it under-warns rather than inventing a clash.
    () => sendResponse({ id: chrome.runtime.id, name: 'linkward' }),
  );
  return true;
});

/**
 * Ask one peer, and give up rather than hang.
 *
 * A peer that is not installed rejects, a peer that is asleep and has no
 * listener for this never answers at all, and neither is an error — absence is
 * the normal case. Both become `null`, which the census ignores.
 */
function ping(id) {
  let asked;
  try {
    asked = chrome.runtime.sendMessage(id, { type: 'cc:ping' });
  } catch {
    // Some browsers throw rather than reject for an id that is not installed.
    return Promise.resolve(null);
  }
  return Promise.race([
    Promise.resolve(asked).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), PING_TIMEOUT_MS)),
  ]);
}

/**
 * Does another add-on already own this host?
 *
 * Reads the cache and nothing else, because this is called from inside a
 * blocking listener. When the cache has gone stale it is refreshed for the NEXT
 * request rather than this one: waiting would hold the page open on a round trip
 * to an add-on that may be asleep, and the worst a stale list costs is a
 * question that did not need asking.
 *
 * `matchesAny` is reused rather than reimplemented — a host matches a pattern
 * and so does every subdomain of it — so "commander manages this host" means
 * exactly what it means everywhere else in this extension.
 */
function standsDownFor(url) {
  if (Date.now() - peerRoutesAt > PEER_ROUTES_TTL_MS) refreshPeerRoutes();
  return peerRoutes.length > 0 && matchesAny(url, peerRoutes);
}

/**
 * Ask the peers what they are routing and remember it.
 *
 * Never awaited by a caller that is holding a request. `answers` is passed in by
 * takeCensus, which has just asked the same question for the settings page —
 * two pings for one fact would be the round trip this cache exists to avoid.
 *
 * A peer that answers nothing is read as not routing, which is what `ping` and
 * `clashes` have always done with silence — its listener is registered
 * synchronously so that a sleeping event page can be started for the ping, so no
 * answer means not installed rather than not awake. Standing down has to agree
 * with the warning about the same fact; two halves of one census disagreeing is
 * the failure this file was written to end.
 *
 * It fails towards asking. The pair coming back is visible in one click; links
 * quietly opening in no container because linkward deferred to an add-on that
 * has been uninstalled is not.
 *
 * A census that throws outright is different, and keeps the previous list: that
 * is this extension failing, not an answer about the other one.
 */
async function refreshPeerRoutes(answers) {
  if (!isFirefox()) return;
  try {
    const replies = answers ?? (await Promise.all(PEERS.map(ping)));
    peerRoutes = peerRouteHosts(replies);
    peerRoutesAt = Date.now();
  } catch {
    // Left exactly as it was, deliberately. See above.
  }
}

async function takeCensus() {
  if (!isFirefox()) {
    return { self: await myRoutingState(), clash: [], line: null, deferring: [] };
  }
  const answers = await Promise.all(PEERS.map(ping));
  // Refreshed BEFORE `self` is read, so the routes linkward publishes and the
  // hosts it is standing down on come from one answer rather than from two a
  // round trip apart. Read the other way round, the page could show a host as
  // both claimed and handed over.
  await refreshPeerRoutes(answers);
  const self = await myRoutingState();
  const clash = clashes(self, answers);
  return { self, clash, line: clashLine(clash), deferring: peerRoutes };
}

/** The options page asks; it does not ping the peers itself. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'linkward:peers') return undefined;
  takeCensus().then(
    (result) => sendResponse(result),
    // Same posture as above: a census that failed says nothing, rather than
    // putting a warning on the page that nobody can act on.
    () => sendResponse({ clash: [], line: null }),
  );
  return true;
});

// --- The one writer of the remembered hosts -------------------------------
//
// Every change is read-modify-write over one object, and the picker and the
// settings page are separate documents that can both be open. Two of them
// writing at once means the later write lands on a map read before the earlier
// one, and a host somebody just pinned is gone. A queue inside a page cannot
// help; the pages share nothing. They share this.
//
// The chain is the whole mechanism: each request waits for the one before it,
// and a failure is passed to the caller rather than breaking the queue.
let writes = Promise.resolve();

function serialise(work) {
  const done = writes.then(work, work);
  // Swallowed HERE, not by the caller: a rejection left on `writes` would make
  // every later write reject with somebody else's error.
  writes = done.catch(() => {});
  return done;
}

async function applyRuleMessage(msg) {
  switch (msg.type) {
    case RULE_MESSAGES.SET:
      return setRule(msg.host, msg.rule);
    case RULE_MESSAGES.REMOVE:
      return removeRule(msg.host);
    case RULE_MESSAGES.REPLACE:
      return setRules(msg.rules);
    default:
      throw new Error(`Unknown rule message: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!Object.values(RULE_MESSAGES).includes(msg?.type)) return undefined;
  serialise(() => applyRuleMessage(msg)).then(
    (rules) => sendResponse({ rules }),
    (err) => sendResponse({ error: String(err?.message || err) }),
  );
  // Keeps the channel open for the async reply. Without it the caller gets
  // undefined and reports success over a write that may not have happened.
  return true;
});

/** The picker tells us which tabs are its doing, so we do not re-ask. */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'linkward:opened' || typeof msg.tabId !== 'number') return;
  ours.add(msg.tabId);
  // And un-flag it. `ours` is only consulted when a tab is CREATED, and that
  // has already happened by the time this message arrives — the tab was
  // flagged a candidate on the way past, and the flag is what the interception
  // actually reads. Leaving it set is a race whose loser is the picker
  // intercepting its own answer.
  candidates.delete(msg.tabId);
});
