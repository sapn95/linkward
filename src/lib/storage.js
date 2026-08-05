// Settings. Small, and all of them in `sync` except the one that names a
// container — a cookieStoreId is handed out per profile, so the same string
// means a different container on another machine.

export const SETTINGS_KEY = 'settings';

/** The three things the picker can do with its "remember this host" box. */
export const REMEMBER_PROMPT = ['hidden', 'unticked', 'ticked'];
const LOCAL_KEY = 'localSettings';
const LOCAL_KEYS = ['lastContainer'];

export const DEFAULT_SETTINGS = {
  // Off until the user turns it on: switching it on is what asks for
  // `<all_urls>`, and an install that never does holds nothing.
  enabled: false,
  // Hosts never to ask about, matched on the host and its subdomains.
  neverAsk: [],
  // What the picker does with its "remember this host" box. Three states,
  // because two cannot say it: a tick box can be on or off, but "do not put it
  // there at all" is a third thing somebody may well want.
  //
  // 'unticked' by default. Ticked, one careless click silences a host for good
  // and the extension quietly stops doing what it was installed for; hidden by
  // default would hide a feature nobody would then find.
  //
  // This replaced a boolean, and the old value is deliberately NOT carried
  // over: it was written by a default that has since been reversed, so for
  // almost everyone holding `true` it records nothing anybody decided.
  rememberPrompt: 'unticked',
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
  // Off disk, so it can be anything — including the boolean this used to be.
  if (!REMEMBER_PROMPT.includes(merged.rememberPrompt)) {
    merged.rememberPrompt = DEFAULT_SETTINGS.rememberPrompt;
  }
  delete merged.rememberChoices;
  return merged;
}

export async function saveSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (!REMEMBER_PROMPT.includes(merged.rememberPrompt)) {
    merged.rememberPrompt = DEFAULT_SETTINGS.rememberPrompt;
  }
  delete merged.rememberChoices;
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

// --- Remembered hosts ------------------------------------------------------
//
// "Always open example.com in Work" is a decision about a CONTAINER, and a
// container is a name to the person who made it and a `cookieStoreId` to the
// browser. The id is minted per profile, so storing only the id and syncing it
// would mean the same rule opening a different container on another machine —
// or none at all. So the name is what is stored and what is matched on, and the
// id is kept beside it as a hint that is only trusted on the machine that wrote
// it.
//
// `container: null` is a rule too, and a deliberate one: "always open this host
// with no container at all".

export const RULES_KEY = 'rules';

/** One entry, from anything that might be on disk. Returns null if unusable. */
function readRule(value) {
  // The shape before rules were synced: a bare cookieStoreId, no name. Still
  // honoured on the machine that wrote it, which is the only place it means
  // anything.
  if (typeof value === 'string') return value ? { container: null, cookieStoreId: value } : null;
  if (!value || typeof value !== 'object') return null;
  const container = typeof value.container === 'string' ? value.container : null;
  const cookieStoreId = typeof value.cookieStoreId === 'string' ? value.cookieStoreId : '';
  // Neither a name nor an id, and `plain` not set: nothing to act on.
  if (!container && !cookieStoreId && !value.plain) return null;
  return { container, cookieStoreId, ...(value.plain ? { plain: true } : {}) };
}

export function readRules(raw) {
  if (!raw || typeof raw !== 'object') return {};
  // Null prototype while filling it: a settings file can carry a `__proto__`
  // key — JSON.parse makes it an own property — and assigning to it on an
  // ordinary object runs the setter, which drops the rule and replaces the
  // prototype of the map the interception then reads. Spreading it out again at
  // the end copies own properties without invoking any setter, so callers get a
  // normal object back.
  const out = Object.create(null);
  for (const [host, value] of Object.entries(raw)) {
    if (typeof host !== 'string' || !host) continue;
    const rule = readRule(value);
    if (rule) out[host.toLowerCase()] = rule;
  }
  return { ...out };
}

/** Per-host decisions the user asked to be remembered. Follows the account. */
export async function getRules() {
  const s = sync();
  const l = local();
  const synced = s ? (await s.get(RULES_KEY))?.[RULES_KEY] : null;
  if (synced) return readRules(synced);
  // Written by a version that kept them local. Read them so nobody's remembered
  // hosts disappear on upgrade; the next write moves them across.
  const here = l ? (await l.get(RULES_KEY))?.[RULES_KEY] : null;
  return readRules(here);
}

export async function setRules(rules) {
  const clean = readRules(rules);
  const s = sync();
  const l = local();
  if (!s && !l) {
    // Resolving quietly here is how a page ends up saying "example.com now
    // opens in Work" over storage that was never touched.
    throw new Error('No extension storage available.');
  }
  if (s) await s.set({ [RULES_KEY]: clean });
  // The read falls back to local for rules an older version left there. Writing
  // only to sync would leave those in place under a newer copy, so a legacy
  // rule that was just deleted comes back the next time sync is empty.
  if (l) await l.set({ [RULES_KEY]: s ? {} : clean });
  return clean;
}

/**
 * @param {string} host
 * @param {{container: string|null, cookieStoreId?: string, plain?: boolean}} rule
 */
export async function setRule(host, rule) {
  const rules = await getRules();
  rules[String(host).toLowerCase()] = rule;
  return setRules(rules);
}

export async function removeRule(host) {
  const rules = await getRules();
  delete rules[String(host).toLowerCase()];
  return setRules(rules);
}
