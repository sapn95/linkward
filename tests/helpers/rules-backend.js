// A stand-in for the one thing that writes the remembered hosts.
//
// The pages do not touch storage any more: they message the background, which
// serialises the writes. A double that let them write directly would be testing
// a page that no longer exists — and would never catch a page that forgot to
// ask.

import { setRule, removeRule, setRules } from '../../src/lib/storage.js';
import { RULE_MESSAGES } from '../../src/lib/rules-client.js';

/**
 * @param {{fail?: string}} [options] - make every write fail, the way the real
 *   one does when synced storage refuses.
 * @returns a `chrome.runtime.sendMessage` that answers rule messages.
 */
export function rulesBackend({ fail } = {}) {
  return async (msg) => {
    if (!Object.values(RULE_MESSAGES).includes(msg?.type)) return undefined;
    if (fail) return { error: fail };
    try {
      switch (msg.type) {
        case RULE_MESSAGES.SET:
          return { rules: await setRule(msg.host, msg.rule) };
        case RULE_MESSAGES.REMOVE:
          return { rules: await removeRule(msg.host) };
        default:
          return { rules: await setRules(msg.rules) };
      }
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  };
}
