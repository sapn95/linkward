import { getSettings, saveSettings, getRules } from '../lib/storage.js';
import { setRule, setRules, removeRule } from '../lib/rules-client.js';
import {
  hasWatchPermissions,
  requestWatchPermissions,
  dropWatchPermissions,
  isFirefox,
  listContainers,
  containerColor,
} from '../lib/containers.js';
import { toTransfer, fromTransfer, fileName } from '../lib/transfer.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

let containersHere = [];

async function init() {
  const settings = await getSettings().catch(() => ({}));
  $('remember-prompt').value = settings.rememberPrompt ?? 'unticked';
  $('never').value = (settings.neverAsk ?? []).join('\n');
  // Shown as what the BROWSER actually grants, not as what was stored: the
  // permission can be handed back in the browser's own add-on settings behind
  // our back, and a tick that lied about that would be worse than no tick.
  $('enabled').checked = Boolean(settings.enabled) && (await hasWatchPermissions());
  showSetupNotice();

  $('enabled').addEventListener('change', onToggle);
  $('remember-prompt').addEventListener('change', save);
  $('never').addEventListener('change', save);
  $('export').addEventListener('click', exportSettings);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importSettings);

  containersHere = await listContainers();
  await renderRules();

  // The manifest is the only thing that knows, and it cannot drift from what is
  // installed the way a constant in the source would.
  $('version').textContent = `linkward ${chrome.runtime.getManifest?.()?.version ?? ''}`.trim();

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
      showSetupNotice();
      say('Access denied — linkward cannot watch anything, so it stays off.');
      return;
    }
  } else {
    await dropWatchPermissions();
  }
  showSetupNotice();
  await save();
}

/** Tied to the tick, which is itself tied to what the browser really grants. */
function showSetupNotice() {
  $('setup').hidden = $('enabled').checked;
}

// --- Remembered sites ------------------------------------------------------

async function renderRules() {
  const rules = await getRules().catch(() => ({}));
  const hosts = Object.keys(rules).sort();
  const list = $('rules');
  list.replaceChildren();
  $('rules-empty').hidden = hosts.length > 0;
  for (const host of hosts) list.append(ruleRow(host, rules[host]));
}

function ruleRow(host, rule) {
  const li = document.createElement('li');

  const name = document.createElement('span');
  name.className = 'host';
  // textContent, never innerHTML: a host comes off a page the user visited.
  name.textContent = host;

  const where = document.createElement('select');
  where.setAttribute('aria-label', `Where ${host} opens`);
  where.append(new Option('No container', ''));
  for (const c of containersHere) {
    const option = new Option(c.name, c.cookieStoreId);
    where.append(option);
  }
  // A rule made on another machine names a container this one may not have.
  // Showing it as "No container" would be a lie, so it is offered as itself and
  // marked, and leaving the row alone leaves the rule alone.
  const known = containersHere.find((c) => c.name === rule.container);
  if (rule.plain || (!rule.container && !rule.cookieStoreId)) {
    where.value = '';
  } else if (known) {
    where.value = known.cookieStoreId;
  } else {
    const missing = new Option(
      `${rule.container ?? 'Unknown container'} (not here)`,
      '__missing__',
    );
    where.append(missing);
    where.value = '__missing__';
  }
  where.addEventListener('change', () => changeRule(host, where.value));

  const dot = document.createElement('span');
  dot.className = 'dot';
  const colour = containerColor(containersHere.find((c) => c.name === rule.container)?.color);
  if (colour) dot.style.background = colour;

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'quiet';
  drop.textContent = 'Forget';
  drop.setAttribute('aria-label', `Forget ${host}`);
  drop.addEventListener('click', async () => {
    try {
      await removeRule(host);
      await renderRules();
      say(`Will ask about ${host} again.`);
    } catch (err) {
      say(`Could not forget ${host}: ${err?.message || err}`);
    }
  });

  li.append(dot, name, where, drop);
  return li;
}

async function changeRule(host, value) {
  // The placeholder for a container this browser does not have. Selecting it is
  // not a change, so nothing is written.
  if (value === '__missing__') return;
  const chosen = containersHere.find((c) => c.cookieStoreId === value);
  const rule = chosen
    ? { container: chosen.name, cookieStoreId: chosen.cookieStoreId }
    : { container: null, cookieStoreId: '', plain: true };
  try {
    // ONE host, not the whole map. Reading every rule here and sending them all
    // back would put the read outside the queue that exists to make this safe:
    // a rule the picker pinned between our read and our write would be erased
    // by a snapshot older than it. setRule reads and writes inside the queue.
    //
    // Synced storage also has a size limit and can refuse. Leaving the new value
    // on screen while the old one is what applies is the worst outcome for a
    // page about where your sessions open.
    await setRule(host, rule);
    await renderRules();
    say(`${host} now opens in ${chosen ? chosen.name : 'no container'}.`);
  } catch (err) {
    await renderRules();
    say(`Could not save that: ${err?.message || err}`);
  }
}

// --- The settings file -----------------------------------------------------

async function exportSettings() {
  // NOT caught into an empty object: a read that failed would be written out as
  // a valid file with nothing in it, reported as a success, and restored later
  // over the settings it was supposed to be a copy of.
  let settings;
  let rules;
  try {
    [settings, rules] = await Promise.all([getSettings(), getRules()]);
  } catch (err) {
    say(`Could not read the settings to export: ${err?.message || err}`);
    return;
  }
  const blob = new Blob([`${JSON.stringify(toTransfer(settings, rules), null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(Date.now());
  // In the document, and revoked a tick later: Firefox will not follow a
  // download from an anchor that was never in the page, and revoking in the
  // same turn as the click has been known to cancel the download it started.
  a.hidden = true;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
  say(`Exported ${Object.keys(rules).length} remembered site(s).`);
}

async function importSettings(e) {
  const file = e.target.files?.[0];
  // Cleared straight away, so choosing the same file twice in a row still fires.
  e.target.value = '';
  if (!file) return;
  try {
    const incoming = fromTransfer(JSON.parse(await file.text()));
    // Also not caught: falling back to the defaults here would quietly reset
    // `enabled` and `lastContainer`, neither of which is in the file.
    const settings = await getSettings();
    // An import REPLACES the remembered sites; it does not merge. Reporting
    // only what arrived would leave somebody with fewer rules than they had
    // and no hint that anything went.
    const before = Object.keys(await getRules().catch(() => ({})));
    const dropped = before.filter((h) => !(h in incoming.rules)).length;
    // `enabled` is never imported: it stands for a permission the browser only
    // grants on a click, and a file cannot click.
    await saveSettings({ ...settings, ...incoming.settings });
    await setRules(incoming.rules);
    $('remember-prompt').value = incoming.settings.rememberPrompt;
    $('never').value = incoming.settings.neverAsk.join('\n');
    await renderRules();
    const kept = Object.keys(incoming.rules).length;
    say(
      dropped
        ? `Imported ${kept} remembered site(s), replacing ${before.length} — ${dropped} no longer remembered.`
        : `Imported ${kept} remembered site(s).`,
    );
  } catch (err) {
    say(`Could not import that file: ${err?.message || err}`);
  }
}

async function save() {
  const settings = await getSettings().catch(() => ({}));
  await saveSettings({
    ...settings,
    enabled: $('enabled').checked,
    rememberPrompt: $('remember-prompt').value,
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
