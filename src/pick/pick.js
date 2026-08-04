// The page the intercepted navigation was turned into.
//
// It is `web_accessible`, so any site can navigate to it with a URL of its
// choosing. Everything that comes out of the query string is therefore treated
// as hostile: shown as text, never as a link, never as HTML, and only ever
// opened after the user has pressed something.

import { listContainers, containerColor, isFirefox } from '../lib/containers.js';
import { getSettings, saveSettings, setRule } from '../lib/storage.js';

const params = new URLSearchParams(location.search);
const raw = params.get('url') ?? '';

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

async function init() {
  if (!target) {
    urlEl.textContent = 'That is not a link this page can open.';
    choicesEl.hidden = true;
    return;
  }
  urlEl.textContent = target.toString();
  hostEl.textContent = target.host;

  const settings = await getSettings().catch(() => ({}));
  rememberEl.checked = Boolean(settings.rememberChoices);

  const containers = await listContainers();
  if (containers.length > 0) {
    renderContainers(containers, settings.lastContainer);
  } else if (isFirefox()) {
    note('This browser has no containers, so there is nothing to choose between.');
  } else {
    // Chrome. Being straight about it is the only honest option: no extension
    // can open a tab in another Chrome profile — the isolation is enforced in
    // Chromium itself — so linkward can hand you the link and nothing more.
    note(
      'Chrome keeps each profile sealed off from extensions, so linkward cannot open ' +
        'this in another one. Copy the link and paste it into the profile you want, or ' +
        'use Chrome’s own right-click “Open Link as…” on the original link.',
    );
  }

  document.getElementById('plain').addEventListener('click', () => open(''));
  document.getElementById('copy').addEventListener('click', copyAndClose);
  document.getElementById('cancel').addEventListener('click', closeTab);
  rememberEl.addEventListener('change', () =>
    saveSettings({ ...settings, rememberChoices: rememberEl.checked }).catch(() => {}),
  );
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

async function open(cookieStoreId) {
  if (!target) return;
  const options = { url: target.toString(), active: true };
  if (cookieStoreId) options.cookieStoreId = cookieStoreId;
  try {
    const tab = await chrome.tabs.create(options);
    // Tell the background this tab is our doing, so the navigation it is about
    // to make is not intercepted straight back to this page.
    chrome.runtime.sendMessage({ type: 'linkward:opened', tabId: tab.id });
    if (rememberEl.checked) await setRule(target.host, cookieStoreId).catch(() => {});
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
