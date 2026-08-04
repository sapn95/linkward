// Reading and writing the settings file.
//
// The export is the boring half. The import is the one worth being careful
// about: it is a file from outside, it can be anything, and what it lands on is
// the list of hosts this extension will stop asking about. So it is validated
// field by field here, in a pure function, rather than trusted and merged.

import { DEFAULT_SETTINGS, readRules } from './storage.js';

export const FORMAT = 'linkward-settings';
export const VERSION = 1;

/** @returns {object} the whole of what a person configured, ready for JSON. */
export function toTransfer(settings, rules) {
  return {
    format: FORMAT,
    version: VERSION,
    settings: {
      neverAsk: [...(settings?.neverAsk ?? [])],
      rememberChoices: Boolean(settings?.rememberChoices),
    },
    rules: readRules(rules),
  };
}

/**
 * Turn a parsed file into settings and rules, or throw with a reason a person
 * can act on.
 *
 * Deliberately NOT imported: `enabled` and `lastContainer`. Switching the
 * feature on is a permission the browser only grants on a click, so a file that
 * claimed `enabled: true` would produce a page saying it is on while nothing
 * was listening. And a cookieStoreId means a different container on the machine
 * the file arrived at.
 */
export function fromTransfer(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('That file does not contain a settings object.');
  }
  if (parsed.format !== FORMAT) {
    throw new Error('That is not a linkward settings file.');
  }
  if (Number(parsed.version) > VERSION) {
    throw new Error(`That file was written by a newer version (${parsed.version}).`);
  }
  const incoming = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
  const neverAsk = Array.isArray(incoming.neverAsk)
    ? [...new Set(incoming.neverAsk.filter((v) => typeof v === 'string').map((v) => v.trim()))]
        .filter(Boolean)
        .sort()
    : [];
  return {
    settings: {
      neverAsk,
      rememberChoices:
        typeof incoming.rememberChoices === 'boolean'
          ? incoming.rememberChoices
          : DEFAULT_SETTINGS.rememberChoices,
    },
    rules: readRules(parsed.rules),
  };
}

/** A name that sorts by date and says what it is. */
export function fileName(stamp) {
  const iso = new Date(stamp).toISOString().slice(0, 10);
  return `linkward-settings-${iso}.json`;
}
