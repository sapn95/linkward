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
import { getSettings, getRules, setRule, removeRule, setRules } from './lib/storage.js';
import { RULE_MESSAGES } from './lib/rules-client.js';

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
  // Read before the flag goes: the picker shows it, and nothing else knows it.
  const since = candidates.get(details.tabId);
  // Answered once per tab: the picker's own navigation must not come back here.
  candidates.delete(details.tabId);

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

// The toolbar button opens the settings in a TAB, not in a popup.
//
// It was a popup, and a popup is a few hundred pixels wide: this page has a
// list of remembered hosts, a dropdown, a textarea and an import/export row,
// and every one of them was folded into a column too narrow to read. A page
// built for a tab belongs in a tab. Removing `default_popup` from the manifest
// is what routes the click here.
chrome.action?.onClicked?.addListener(() => chrome.runtime.openOptionsPage());
// The only one that really matters after the first run: this is the moment the
// permission arrives and `chrome.webRequest` becomes something we can add to.
chrome.permissions.onAdded.addListener(arm);

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
