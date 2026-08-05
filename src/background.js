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

import { shouldAsk, isCandidateTab, matchesAny } from './lib/candidates.js';
import { isFirefox, listContainers, resolveRule } from './lib/containers.js';
import { getSettings, getRules } from './lib/storage.js';

const PICK_PAGE = 'pick/pick.html';
// How long after a tab appears its first navigation still counts as the one the
// tab was created for. Long enough for a slow hand-off from another app, short
// enough that ordinary browsing in that tab is never touched.
const FRESH_MS = 5000;

// tabId -> when it was flagged. A Map, not storage: this is per-session state
// and a worker restart should forget it rather than ask about a stale tab.
const candidates = new Map();
// Tabs linkward opened itself. Without this the picker's own "open it" would be
// intercepted and we would ask about our own answer, for ever.
const ours = new Set();
// How many tabs linkward is in the middle of opening. See openThere().
let opening = 0;

chrome.tabs.onCreated.addListener((tab) => {
  if (opening > 0) {
    opening--;
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
  // Answered once per tab: the picker's own navigation must not come back here.
  candidates.delete(details.tabId);

  // A remembered host is the whole point of the tick box on the picker, and
  // until now nothing read these back — the box wrote a rule that was never
  // consulted, so it promised something that did not happen.
  const remembered = await rememberedFor(details.url);
  if (remembered !== undefined) return { open: remembered };

  const target = new URL(chrome.runtime.getURL(PICK_PAGE));
  target.searchParams.set('url', details.url);
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
 * `opening` exists because tabs.onCreated fires before tabs.create resolves:
 * claiming the new tab only afterwards is a race, and its loser is an endless
 * loop of linkward asking about its own answer. The counter claims the next tab
 * to appear; clearing the flags again once the id is known covers the case
 * where something else got there first.
 */
async function openThere(tabId, url, cookieStoreId) {
  opening++;
  let created;
  try {
    created = await chrome.tabs.create({ url, active: true, cookieStoreId });
  } catch {
    // The container went away between resolving the rule and acting on it. The
    // original request is already cancelled, so put the picker in that tab
    // rather than leave a blank one and no explanation.
    opening = Math.max(0, opening - 1);
    const target = new URL(chrome.runtime.getURL(PICK_PAGE));
    target.searchParams.set('url', url);
    await chrome.tabs.update(tabId, { url: target.toString() }).catch(() => {});
    return;
  }
  // Whether or not onCreated got there first, the claim is spent now. Left
  // standing it would be collected by the next tab to appear — a genuinely
  // external link, silently treated as our own and never asked about.
  // Nothing is lost by dropping it: onCreated checks `ours` as well, and the id
  // is known from here on.
  opening = 0;
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
    if (chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) return;
    chrome.webRequest.onBeforeRequest.addListener(
      onBeforeRequest,
      { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
      ['blocking'],
    );
  } catch {
    // No permission yet. permissions.onAdded will bring us back here.
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

// --- Chrome: turn the tab around as early as it allows ---------------------
// Synchronous for the same reason: a service worker is stopped when idle and
// restarted for its listeners, and only the ones registered on the first run
// can restart it.
function armChrome() {
  if (isFirefox()) return;
  try {
    if (chrome.webNavigation.onBeforeNavigate.hasListener(onBeforeNavigate)) return;
    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
  } catch {
    // Same as above: no webNavigation permission yet.
  }
}

async function onBeforeNavigate(details) {
  if (details.frameId !== 0) return;
  // webNavigation gives no originUrl, so the document check in shouldAsk cannot
  // apply. The candidate flag and the freshness window carry it alone here,
  // which is why the Chrome build asks in more situations than the Firefox one.
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

function arm() {
  armFirefox();
  armChrome();
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
// The only one that really matters after the first run: this is the moment the
// permission arrives and `chrome.webRequest` becomes something we can add to.
chrome.permissions.onAdded.addListener(arm);

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
