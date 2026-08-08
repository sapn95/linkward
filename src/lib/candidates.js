// Which navigations linkward is allowed to interrupt.
//
// This is the whole risk of the extension, so it is a pure function with no
// browser APIs in it, and it is the most heavily tested thing in the repo.
//
// The honest starting point: **Firefox does not tell an extension that a link
// came from another application.** It knows — `isExternal` in
// BrowserDOMWindow.sys.mjs — and never exposes it. What an extension sees for a
// link handed over by Slack is `transitionType: "link"`, byte for byte the same
// as a click on a page. Mozilla's own bug for this has been open since 2022.
//
// So this is a set of EXCLUSIONS, not a detection. Everything that can be
// positively identified as something else is subtracted, and what is left is
// treated as "probably external". Getting that wrong in the permissive
// direction means interrupting a link the user clicked themselves, which is
// the failure that would make people uninstall — so every rule below errs
// towards NOT asking.

/** Only ordinary web pages. A file:// or moz-extension:// page is not ours. */
export function isInterceptable(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Is this tab a candidate at the moment it is created?
 *
 * @param {object} tab - a browser Tab
 * @param {boolean} openedByUs - linkward opened it, so it must not re-ask
 */
export function isCandidateTab(tab, { openedByUs = false } = {}) {
  if (openedByUs) return false;
  // An opener means a page or a script in this browser opened it: a target
  // _blank link, a window.open, a middle click. Not external.
  if (tab?.openerTabId !== undefined && tab?.openerTabId !== null) return false;

  // A tab that was HANDED a link starts on that link — an http(s) address.
  // Anything else with a name is one of the browser's own pages: a new tab, a
  // start page, a session-restore placeholder. The user is about to type in it,
  // and what they type is not an external link.
  //
  // This used to be a list of four names — about:blank, about:newtab,
  // about:home, chrome://newtab/ — which is the wrong way round. Every browser
  // has its own, Vivaldi's start page is not among them, and the consequence
  // was linkward interrupting a search typed into the address bar of a fresh
  // tab. Asking about something the user typed themselves is the failure that
  // gets an add-on uninstalled.
  //
  // An EMPTY url stays a candidate: it means the browser has not said yet, not
  // that there is nothing.
  const url = tab?.pendingUrl || tab?.url || '';
  if (url && !isInterceptable(url)) return false;
  return true;
}

/**
 * Should this request be interrupted?
 *
 * `details` is a webRequest onBeforeRequest record. The two fields that carry
 * the weight:
 *   - `originUrl` / `documentUrl` are set when a DOCUMENT started the
 *     navigation. Absent means nothing on a page did — which is true of an
 *     external open, and also of the address bar and of bookmarks.
 *   - `tabId` must be one we flagged at creation time, recently.
 *
 * @param {object} details
 * @param {(tabId:number)=>number|undefined} candidateSince - when the tab was flagged
 * @param {(url:string)=>boolean} isExcluded - user's never-ask list
 * @param {number} now
 * @param {number} freshMs - how long after a tab appears a request still counts
 */
export function shouldAsk(
  details,
  { candidateSince, isExcluded, now = Date.now(), freshMs = 5000 } = {},
) {
  if (details?.type !== 'main_frame') return false;
  if (!isInterceptable(details?.url)) return false;
  // Started by a page — a link click, a redirect, a form. Never ours.
  if (details.originUrl || details.documentUrl) return false;
  const since = candidateSince?.(details.tabId);
  if (since === undefined) return false;
  // Stale: the tab was flagged minutes ago and the user has been browsing in it
  // since. Only the FIRST navigation after a tab appears can be the external one.
  if (now - since > freshMs) return false;
  if (isExcluded?.(details.url)) return false;
  return true;
}

// --- Was the browser already in front? -------------------------------------
//
// The exclusions above cannot separate these four, because to `webRequest` and
// `webNavigation` they are byte for byte identical — a new tab, an http(s)
// address, no opener, navigating within a few seconds:
//
//   a link handed over by Slack, Outlook, a terminal   ← the only one we want
//   a bookmark
//   an address typed or pasted into a new tab
//   a search from the address bar
//
// The field that names them is `transitionType` — `auto_bookmark`, `typed`,
// `link` — and it exists ONLY on webNavigation.onCommitted, which is after the
// request has gone. Firefox's blocking webRequest has no equivalent at all, and
// that build is the one where interception is exact; a fix that moved the
// decision to onCommitted would take away the reason to use it.
//
// So: the one thing that is knowable BEFORE the request, on both browsers, and
// that actually differs between the four.
//
// A bookmark, an address bar, a history entry — all of them are somebody
// already in the browser, using the browser. A link from another application
// is, by definition, somebody who was NOT: they were in Slack, and the browser
// is being brought to the front to receive it. `windows.onFocusChanged` says
// which of those just happened.
//
// It is a proxy, not the fact, and it is wrong in two places named in the
// README. Both err towards asking, which is the direction the rest of this file
// errs in too.

/**
 * How long after the browser comes to the front a new tab still counts as the
 * reason it was brought there.
 *
 * The focus change and the tab arrive within the same handful of milliseconds
 * on a warm browser, and up to a few hundred on one that had to start. Wide
 * enough to cover that; narrow enough that "switch to the browser, then open a
 * bookmark" is over it long before the click lands.
 */
export const FOCUS_GRACE_MS = 1500;

/**
 * Was this tab opened from INSIDE the browser?
 *
 * @param {{focusedSince?: number|null}} focus - when the browser last came to
 *   the front; `null` for "it is behind something else", missing for "we do not
 *   know yet".
 * @param {{at?: number, graceMs?: number}} when - `at` is when the TAB was
 *   created, not now: by the time this is asked the browser is always in front.
 * @returns {boolean} true only when we positively know it started in here.
 */
export function startedInsideBrowser(focus, { at = Date.now(), graceMs = FOCUS_GRACE_MS } = {}) {
  const since = focus?.focusedSince;
  // Not focused, or nothing recorded. Neither is evidence of anything, and the
  // answer to "no evidence" is the behaviour without this rule: ask.
  if (!Number.isFinite(since)) return false;
  // Negative when the focus event landed after the tab did, which is the
  // ordinary race on a hand-off. Still inside the window, still not ours.
  return at - since > graceMs;
}

/**
 * Does `url` match one of the user's never-ask patterns?
 *
 * Patterns are hosts, matched on the host and any subdomain of it, because
 * "never ask for anything on example.com" is what people mean when they type
 * that. Deliberately not globs: a wrong glob here means the extension silently
 * stops asking, and nobody would notice.
 */
export function matchesAny(url, patterns) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return (Array.isArray(patterns) ? patterns : []).some((raw) => {
    const p = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '');
    if (!p) return false;
    return host === p || host.endsWith(`.${p}`);
  });
}
