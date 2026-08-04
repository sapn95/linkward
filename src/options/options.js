import { getSettings, saveSettings } from '../lib/storage.js';
import {
  hasWatchPermissions,
  requestWatchPermissions,
  dropWatchPermissions,
  isFirefox,
} from '../lib/containers.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

async function init() {
  const settings = await getSettings().catch(() => ({}));
  $('remember').checked = Boolean(settings.rememberChoices);
  $('never').value = (settings.neverAsk ?? []).join('\n');
  // Shown as what the BROWSER actually grants, not as what was stored: the
  // permission can be handed back in the browser's own add-on settings behind
  // our back, and a tick that lied about that would be worse than no tick.
  $('enabled').checked = Boolean(settings.enabled) && (await hasWatchPermissions());

  $('enabled').addEventListener('change', onToggle);
  $('remember').addEventListener('change', save);
  $('never').addEventListener('change', save);

  $('honest').textContent = isFirefox()
    ? 'Firefox lets linkward stop the request before it is sent, so the page is never fetched.'
    : 'Chrome removed the ability to stop a request, so linkward can only turn the tab around ' +
      'once the navigation has started. And no extension can open a tab in another Chrome ' +
      'profile — that isolation is enforced by Chrome itself.';
}

async function onToggle(e) {
  // The request must be the FIRST thing in the handler: a handler stops being
  // user-initiated the moment it awaits, and permissions.request then fails.
  if (e.target.checked) {
    const granted = await requestWatchPermissions();
    if (!granted) {
      e.target.checked = false;
      say('Access denied — linkward cannot watch anything, so it stays off.');
      return;
    }
  } else {
    await dropWatchPermissions();
  }
  await save();
}

async function save() {
  const settings = await getSettings().catch(() => ({}));
  await saveSettings({
    ...settings,
    enabled: $('enabled').checked,
    rememberChoices: $('remember').checked,
    neverAsk: $('never')
      .value.split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  });
  say('Saved.');
}

function say(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

await init();
