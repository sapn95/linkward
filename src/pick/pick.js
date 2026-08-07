// The page the intercepted navigation was turned into.
//
// It is `web_accessible`, so any site can navigate to it with a URL of its
// choosing. Everything that comes out of the query string is therefore treated
// as hostile: shown as text, never as a link, never as HTML, and only ever
// opened after the user has pressed something.

import { listContainers, containerColor, isFirefox } from '../lib/containers.js';
import { getSettings, saveSettings } from '../lib/storage.js';
import { setRule } from '../lib/rules-client.js';

const params = new URLSearchParams(location.search);
const raw = params.get('url') ?? '';
// How long ago the tab this replaced was opened. Passed by the background,
// which is the only thing that knows.
//
// `has` first: a missing parameter reads as null, and Number(null) is 0 — a
// perfectly finite, non-negative zero that would print "opened 0s ago" on every
// page that was never told.
const age = params.has('age') ? Number(params.get('age')) : NaN;

const urlEl = document.getElementById('url');
const choicesEl = document.getElementById('choices');
const hostEl = document.getElementById('host');
const rememberEl = document.getElementById('remember');
const noteEl = document.getElementById('note');
const statusEl = document.getElementById('status');

/** Only ever open something we would have intercepted in the first place. */
function safeTarget(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

const target = safeTarget(raw);

// Needed again when a choice is remembered: a rule stores the container's NAME,
// and only this list can turn the id that was clicked back into one.
let containersHere = [];

async function init() {
  if (!target) {
    urlEl.textContent = 'That is not a link this page can open.';
    choicesEl.hidden = true;
    return;
  }
  urlEl.textContent = target.toString();
  hostEl.textContent = target.host;

  // Before the first await, and that is the point: isFirefox() is synchronous,
  // while settings and containers are not. Deciding the wording after them
  // paints "Where should this open?" and "No container" on a Chromium screen
  // for as long as storage takes — the exact words this build exists to stop
  // showing, arriving as a flicker instead.
  if (!isFirefox()) {
    document.getElementById('title').textContent = 'Open this link?';
    document.getElementById('plain').textContent = 'Open it';
  }

  const settings = await getSettings().catch(() => ({}));
  // Hidden means hidden: the box is not rendered, so nothing on this page can
  // pin a host by accident.
  const prompt = settings.rememberPrompt ?? 'unticked';
  document.getElementById('remember-row').hidden = prompt === 'hidden';
  rememberEl.checked = prompt === 'ticked';

  why(age);

  const containers = await listContainers();
  containersHere = containers;
  if (containers.length > 0) {
    renderContainers(containers, settings.lastContainer);
  } else if (isFirefox()) {
    // A dead end otherwise: "there is nothing to choose between" is true and
    // useless. Containers are built into Firefox but there is no obvious way to
    // make one without Mozilla's own add-on, so name it — linkward will use
    // whatever it creates, and does not need to be told about it.
    note(
      'Firefox has containers built in, but none have been made yet. Mozilla’s ' +
        '“Multi-Account Containers” add-on is the usual way to create and name them; ' +
        'linkward picks up whatever is there, with no setting to connect the two.',
    );
  } else {
    // Chromium. Being straight about it is the only honest option, and saying
    // WHY costs one sentence: `tabs.create` takes a window to aim at and no
    // profile, because an extension in one profile cannot see that the others
    // exist. "Not supported yet" would be a promise; this is a wall.
    note(
      'Chromium seals each profile off from extensions, so linkward can only reach this ' +
        'one — which profile a link opens in is settled before the browser is handed it. ' +
        'Copy the link and paste it where you want it, use the right-click “Open Link ' +
        'as…” on the original, or let something outside the browser route it. The README ' +
        'lists what actually works.',
    );
  }

  document.getElementById('plain').addEventListener('click', () => open(''));
  document.getElementById('copy').addEventListener('click', copyAndClose);
  document.getElementById('cancel').addEventListener('click', closeTab);
  document.addEventListener('keydown', onKey);
  // The tick is NOT written back as a preference. It applies to this one link.
  //
  // It used to save itself, so ticking it once for a single site quietly turned
  // it on for every link that followed — a box on a page about ONE address
  // changing what happens to all the others, with nothing on screen saying so.
  // Whether it starts ticked is a decision for the settings page, which is
  // where a decision about every link belongs.
}

/**
 * Say why the question appeared.
 *
 * linkward does not detect external links — it excludes everything it can
 * identify as something else and asks about the rest. So when it gets one
 * wrong, the person interrupted has no idea what set it off, and neither does
 * anybody they report it to. One line fixes that.
 */
function why(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const seconds = Math.round(ms / 100) / 10;
  const el = document.getElementById('why');
  el.textContent =
    `Asked because this tab was opened ${seconds}s ago and nothing in the browser ` +
    'accounts for it — no page opened it, and you had not been browsing in it.';
  el.hidden = false;
}

function renderContainers(containers, last) {
  // Last used first: the same link from the same app usually wants the same
  // container, and the whole point is to be faster than doing it by hand.
  const ordered = [...containers].sort((a, b) =>
    a.cookieStoreId === last ? -1 : b.cookieStoreId === last ? 1 : 0,
  );
  for (const c of ordered) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const colour = containerColor(c.color);
    if (colour) dot.style.background = colour;
    btn.append(dot, document.createTextNode(c.name));
    btn.addEventListener('click', () => open(c.cookieStoreId));
    li.append(btn);
    choicesEl.append(li);
  }
}

/**
 * The keys. This page is seen many times a day and interrupts something, so
 * reaching for the mouse is most of what it costs.
 *
 * Ignored while a modifier is held: those belong to the browser, and stealing
 * ⌘C from somebody trying to copy the address would be its own small betrayal.
 */
function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const buttons = [...choicesEl.querySelectorAll('button')];
  const digit = Number(e.key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= buttons.length) {
    e.preventDefault();
    buttons[digit - 1].click();
    return;
  }
  switch (e.key) {
    case 'Enter':
      // The one offered first — the container used last, or plainly if there
      // are none. Enter is the answer somebody wanted often enough to look for.
      e.preventDefault();
      (buttons[0] ?? document.getElementById('plain')).click();
      break;
    case 'Escape':
      e.preventDefault();
      closeTab();
      break;
    case 'c':
      e.preventDefault();
      copyAndClose();
      break;
    default:
  }
}

async function open(cookieStoreId) {
  if (!target) return;
  const options = { url: target.toString(), active: true };
  if (cookieStoreId) options.cookieStoreId = cookieStoreId;
  try {
    const tab = await chrome.tabs.create(options);
    // Tell the background this tab is our doing, so the navigation it is about
    // to make is not intercepted straight back to this page.
    chrome.runtime.sendMessage({ type: 'linkward:opened', tabId: tab.id });
    // The NAME, not just the id: an id is minted per profile, and this rule
    // follows the account onto machines where the same id means nothing. The id
    // travels alongside as a hint for this machine.
    if (rememberEl.checked) {
      const chosen = containersHere.find((c) => c.cookieStoreId === cookieStoreId);
      await setRule(target.host, {
        container: chosen?.name ?? null,
        cookieStoreId,
        ...(cookieStoreId ? {} : { plain: true }),
      }).catch(() => {});
    }
    await saveSettings({
      ...(await getSettings()),
      lastContainer: cookieStoreId,
    }).catch(() => {});
    closeTab();
  } catch (e) {
    // A container deleted between the page loading and the click, or the
    // `cookies` permission handed back. Say so rather than doing nothing.
    say(`Could not open it there: ${e?.message || e}`);
  }
}

async function copyAndClose() {
  try {
    await navigator.clipboard.writeText(target.toString());
    say('Copied. Nothing was opened.');
  } catch {
    say('Could not reach the clipboard — select the link above and copy it.');
  }
}

function closeTab() {
  chrome.tabs.getCurrent().then((tab) => tab && chrome.tabs.remove(tab.id));
}

function note(text) {
  noteEl.textContent = text;
  noteEl.hidden = false;
}

function say(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

await init();
