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

/** Firefox/Chrome hand these to a new tab before anything is loaded. */
const BLANK_PAGES = new Set(['about:blank', 'about:newtab', 'about:home', 'chrome://newtab/']);

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
  // A tab that starts on a real URL was handed one; a blank one is the user
  // opening an empty tab and typing into it. Both reach us, only the first can
  // be external.
  const url = tab?.url ?? '';
  if (url && BLANK_PAGES.has(url)) return false;
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
