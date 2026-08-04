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
import { hasWatchPermissions, isFirefox } from './lib/containers.js';
import { getSettings } from './lib/storage.js';

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

chrome.tabs.onCreated.addListener((tab) => {
  if (isCandidateTab(tab, { openedByUs: ours.has(tab.id) })) {
    candidates.set(tab.id, Date.now());
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  candidates.delete(tabId);
  ours.delete(tabId);
});

/** Shared by both browsers: decide, then hand the tab to the picker. */
async function decide(details) {
  const settings = await getSettings();
  if (!settings.enabled) return null;
  const ask = shouldAsk(details, {
    candidateSince: (id) => candidates.get(id),
    isExcluded: (url) => matchesAny(url, settings.neverAsk),
    freshMs: FRESH_MS,
  });
  if (!ask) return null;
  // Answered once per tab: the picker's own navigation must not come back here.
  candidates.delete(details.tabId);
  const target = new URL(chrome.runtime.getURL(PICK_PAGE));
  target.searchParams.set('url', details.url);
  return target.toString();
}

// --- Firefox: stop it before the request is sent ---------------------------
async function armFirefox() {
  if (!isFirefox()) return;
  if (!(await hasWatchPermissions())) return;
  if (chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) return;
  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
    ['blocking'],
  );
}

// Returns a promise, which Firefox honours for blocking listeners. The request
// stays suspended until it resolves, which is what makes "nothing was fetched"
// true rather than a hope.
function onBeforeRequest(details) {
  return decide(details).then((redirectUrl) => (redirectUrl ? { redirectUrl } : {}));
}

// --- Chrome: turn the tab around as early as it allows ---------------------
async function armChrome() {
  if (isFirefox()) return;
  if (!(await hasWatchPermissions())) return;
  if (chrome.webNavigation.onBeforeNavigate.hasListener(onBeforeNavigate)) return;
  chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
}

async function onBeforeNavigate(details) {
  if (details.frameId !== 0) return;
  // webNavigation gives no originUrl, so the document check in shouldAsk cannot
  // apply. The candidate flag and the freshness window carry it alone here,
  // which is why the Chrome build asks in more situations than the Firefox one.
  const url = await decide({ ...details, type: 'main_frame' });
  if (url) chrome.tabs.update(details.tabId, { url });
}

async function arm() {
  await armFirefox();
  await armChrome();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await arm();
  // Everything here needs a permission the browser will only grant on a click,
  // so a fresh install does nothing at all until someone finds the options page
  // and switches it on. Nobody goes looking for a settings page for an
  // extension that has never done anything: the first impression is a link
  // opening exactly as it always did, which reads as broken. So open the page
  // once, on install, and let it explain itself.
  if (details?.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(arm);
chrome.permissions.onAdded.addListener(arm);
chrome.storage.onChanged.addListener(arm);
arm();

/** The picker tells us which tabs are its doing, so we do not re-ask. */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'linkward:opened' && typeof msg.tabId === 'number') ours.add(msg.tabId);
});
