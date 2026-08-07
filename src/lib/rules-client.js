// How a PAGE changes the remembered hosts.
//
// It asks the background to do it, and does not write itself. The picker and
// the settings page are separate documents that can be open at the same time,
// and every change here is read-modify-write on one object: read the map, alter
// one host, write the whole thing back. Two pages doing that at once means the
// later write lands on a map read before the earlier one — and a host somebody
// pinned a second ago is gone, with nothing shown and nothing logged.
//
// A queue inside one page cannot fix that; the two pages have no queue in
// common. The background is the one thing both can see, so it owns the writes
// and serialises them, and the pages ask.

const SET = 'linkward:rules:set';
const REMOVE = 'linkward:rules:remove';
const REPLACE = 'linkward:rules:replace';

export const RULE_MESSAGES = { SET, REMOVE, REPLACE };

/**
 * Ask, and fail loudly if nobody answers.
 *
 * `sendMessage` rejects when the background is gone, and resolves with an
 * `{ error }` when it refused — either way the caller must hear about it, or a
 * settings page reports a change over storage that never happened.
 */
async function ask(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (reply?.error) throw new Error(reply.error);
  return reply?.rules ?? {};
}

/** @param {{container: string|null, cookieStoreId?: string, plain?: boolean}} rule */
export function setRule(host, rule) {
  return ask({ type: SET, host, rule });
}

export function removeRule(host) {
  return ask({ type: REMOVE, host });
}

/** Replaces the lot — what an imported settings file does. */
export function setRules(rules) {
  return ask({ type: REPLACE, rules });
}
