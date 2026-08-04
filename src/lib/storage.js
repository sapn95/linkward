// Settings. Small, and all of them in `sync` except the one that names a
// container — a cookieStoreId is handed out per profile, so the same string
// means a different container on another machine.

export const SETTINGS_KEY = 'settings';
const LOCAL_KEY = 'localSettings';
const LOCAL_KEYS = ['lastContainer'];

export const DEFAULT_SETTINGS = {
  // Off until the user turns it on: switching it on is what asks for
  // `<all_urls>`, and an install that never does holds nothing.
  enabled: false,
  // Hosts never to ask about, matched on the host and its subdomains.
  neverAsk: [],
  // Remember the choice per host and stop asking for it again.
  rememberChoices: true,
  // The container picked last, offered first next time. Machine-local.
  lastContainer: '',
};

const sync = () => (globalThis.chrome && chrome.storage ? chrome.storage.sync : null);
const local = () => (globalThis.chrome && chrome.storage ? chrome.storage.local : null);

export async function getSettings() {
  const s = sync();
  const l = local();
  const stored = {
    ...(s ? (await s.get(SETTINGS_KEY))?.[SETTINGS_KEY] : null),
  };
  const legacy = {};
  for (const k of LOCAL_KEYS) {
    if (k in stored) legacy[k] = stored[k];
    delete stored[k];
  }
  const here = l ? (await l.get(LOCAL_KEY))?.[LOCAL_KEY] : null;
  const merged = { ...DEFAULT_SETTINGS, ...stored, ...(here ?? legacy) };
  // Straight off disk, so it can be anything at all; a non-array reaches a
  // `.some()` in the hot path and would throw where nothing catches it.
  merged.neverAsk = Array.isArray(merged.neverAsk)
    ? merged.neverAsk.filter((v) => typeof v === 'string')
    : [];
  return merged;
}

export async function saveSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const synced = { ...merged };
  const here = {};
  for (const k of LOCAL_KEYS) {
    here[k] = merged[k];
    delete synced[k];
  }
  // Local first: the synced write is the one with a quota that can reject, and
  // doing it first would throw away the half that was never going to fail.
  const l = local();
  const s = sync();
  if (l) await l.set({ [LOCAL_KEY]: here });
  if (s) await s.set({ [SETTINGS_KEY]: synced });
  return { ...synced, ...here };
}

/** Per-host decisions the user asked to be remembered. Machine-local. */
export async function getRules() {
  const l = local();
  if (!l) return {};
  const r = (await l.get('rules'))?.rules;
  return r && typeof r === 'object' ? r : {};
}

export async function setRule(host, cookieStoreId) {
  const l = local();
  if (!l) return;
  const rules = await getRules();
  rules[host] = cookieStoreId;
  await l.set({ rules });
}
