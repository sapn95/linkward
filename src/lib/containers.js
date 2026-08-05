// Firefox containers ("contextual identities"), and the permissions that make
// them usable.
//
// Chrome has no counterpart. Every entry point answers "there are none" rather
// than throwing, so one codebase serves both builds. The feature can also be
// switched off inside Firefox (privacy.userContext.enabled), and then the API
// is either missing outright or its promises reject — both look the same here.

export const DEFAULT_STORE = 'firefox-default';

/** Does this cookie store id name a real, lasting container? */
export function isContained(cookieStoreId) {
  return (
    typeof cookieStoreId === 'string' &&
    cookieStoreId !== '' &&
    cookieStoreId !== DEFAULT_STORE &&
    // A private window's store dies with the window; nothing may be pinned to it.
    !cookieStoreId.startsWith('firefox-private')
  );
}

// Firefox exposes promise-style APIs on `browser`, Chrome MV3 on `chrome`. The
// namespace is absent entirely when the permission is not granted.
const identities = () =>
  globalThis.browser?.contextualIdentities ?? globalThis.chrome?.contextualIdentities ?? null;
const permissions = () => globalThis.browser?.permissions ?? globalThis.chrome?.permissions ?? null;

/**
 * Every container this browser has. Resolves to [] on Chrome, with containers
 * switched off, or on any failure — a browser without them must not break.
 */
export async function listContainers() {
  const api = identities();
  if (!api?.query) return [];
  try {
    const found = await api.query({});
    if (!Array.isArray(found)) return [];
    return found
      .filter((c) => isContained(c?.cookieStoreId))
      .map((c) => ({
        cookieStoreId: c.cookieStoreId,
        name: String(c.name ?? '').trim() || c.cookieStoreId,
        color: c.color,
      }));
  } catch {
    return [];
  }
}

// Firefox's own container palette. A lookup with a fallback rather than a fixed
// list: Firefox 153 renamed some colours and added others, and an add-on that
// insists on knowing every name is one release away from being wrong. An
// unknown name simply gets no colour — the container is still named in words.
const COLORS = {
  blue: '#37adff',
  turquoise: '#00c79a',
  green: '#51cd00',
  yellow: '#ffcb00',
  orange: '#ff9f00',
  red: '#ff613d',
  pink: '#ff4bda',
  purple: '#af51f5',
  toolbar: 'currentColor',
};

/**
 * Turn a remembered rule into something openable, against the containers this
 * browser has right now.
 *
 * Returns a cookieStoreId, `''` for "open with no container", or `undefined`
 * for "this rule cannot be honoured here" — a rule made on another machine, or
 * for a container since renamed or deleted. Undefined must mean ASK: silently
 * opening somewhere else would be the one failure a user of this extension
 * cannot forgive.
 *
 * @param {{container: string|null, cookieStoreId?: string, plain?: boolean}|null} rule
 * @param {Array<{cookieStoreId: string, name: string}>} containers
 */
export function resolveRule(rule, containers = []) {
  if (!rule || typeof rule !== 'object') return undefined;
  if (rule.plain) return '';
  const list = Array.isArray(containers) ? containers : [];
  const wanted = typeof rule.container === 'string' ? rule.container.trim().toLowerCase() : '';
  if (wanted) {
    const byName = list.find(
      (c) =>
        String(c?.name ?? '')
          .trim()
          .toLowerCase() === wanted,
    );
    if (byName) return byName.cookieStoreId;
  }
  // The id is a fallback for LEGACY rules only — the ones written before names
  // were stored, which have nothing else to go on.
  //
  // It must not be reached once a name has been tried and missed. Ids are
  // handed out per profile and get reused: a rule saying "Admin" whose stored
  // id now belongs to "Work" would resolve to Work, and the link would open in
  // the wrong identity without a word. That is the precise failure this
  // extension exists to prevent, so a named rule that cannot be matched by name
  // asks, full stop.
  if (!wanted && rule.cookieStoreId && list.some((c) => c?.cookieStoreId === rule.cookieStoreId)) {
    return rule.cookieStoreId;
  }
  return undefined;
}

/** A CSS colour for a container, or '' for a name this build does not know. */
export function containerColor(color) {
  const key = String(color ?? '').toLowerCase();
  // hasOwn, not a plain lookup: `constructor` would otherwise come back truthy.
  return Object.hasOwn(COLORS, key) ? COLORS[key] : '';
}

/**
 * The permissions the interception needs, as one request.
 *
 * `<all_urls>` is the expensive one and the only one the user sees — Firefox
 * shows "Access your data for all websites". webRequest/webRequestBlocking are
 * on Firefox's silently-granted list. They are asked for TOGETHER because
 * permissions.request must run inside a user gesture, and a handler loses that
 * status the moment it awaits anything: a second request always fails.
 */
export function watchPermissions(firefox = isFirefox()) {
  return {
    origins: ['<all_urls>'],
    permissions: firefox ? ['webRequest', 'webRequestBlocking'] : ['webNavigation'],
  };
}

/** The Firefox build, told apart by its own extension origin. No permission. */
export function isFirefox() {
  try {
    return chrome.runtime.getURL('/').startsWith('moz-extension://');
  } catch {
    return false;
  }
}

export async function hasWatchPermissions() {
  const api = permissions();
  if (!api?.contains) return false;
  try {
    return await api.contains(watchPermissions());
  } catch {
    return false;
  }
}

/** Must be called from inside a user gesture, before any await. */
export async function requestWatchPermissions() {
  const api = permissions();
  if (!api?.request) return false;
  try {
    return await api.request(watchPermissions());
  } catch {
    return false;
  }
}

export async function dropWatchPermissions() {
  const api = permissions();
  if (!api?.remove) return false;
  try {
    return await api.remove(watchPermissions());
  } catch {
    return false;
  }
}
