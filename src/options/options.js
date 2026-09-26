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
  $('ask-internal').checked = settings.askInternal === true;
  $('never').value = (settings.neverAsk ?? []).join('\n');
  // Shown as what the BROWSER actually grants, not as what was stored: the
  // permission can be handed back in the browser's own add-on settings behind
  // our back, and a tick that lied about that would be worse than no tick.
  $('enabled').checked = Boolean(settings.enabled) && (await hasWatchPermissions());
  showSetupNotice();

  $('enabled').addEventListener('change', onToggle);
  $('remember-prompt').addEventListener('change', save);
  $('ask-internal').addEventListener('change', save);
  $('never').addEventListener('change', save);
  $('export').addEventListener('click', exportSettings);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importSettings);

  containersHere = await listContainers();
  await renderRules();

  // The manifest is the only thing that knows, and it cannot drift from what is
  // installed the way a constant in the source would.
  $('version').textContent = `linkward ${chrome.runtime.getManifest?.()?.version ?? ''}`.trim();

  // The two builds decide this differently, and one sentence describing both
  // would be wrong on one of them. Chromium answers outright; Firefox holds the
  // request before anything has been said, so it goes by a proxy — and a page
  // that claimed the proxy's precision on Chromium, or Chromium's precision on
  // Firefox, would be lying about the one thing this box controls.
  $('internal-note').textContent = isFirefox()
    ? 'Off, because a bookmark is not a link from somewhere else — you already said where it ' +
      'goes by saving it. Firefox says nothing about how a navigation started until after the ' +
      'request has gone, and linkward holds it before that, so it goes by whether the browser ' +
      'was already in front. That is a proxy, and it is wrong in two places listed in the readme.'
    : 'Off, because a bookmark is not a link from somewhere else — you already said where it ' +
      'goes by saving it. This browser says how each navigation started, so bookmarks, the ' +
      'address bar and searches are recognised rather than guessed at.';

  $('honest').textContent = isFirefox()
    ? 'Firefox lets linkward stop the request before it is sent, so the page is never fetched.'
    : 'Chrome removed the ability to stop a request, so linkward can only turn the tab around ' +
      'once the navigation has started. And no extension can open a tab in another Chrome ' +
      'profile — that isolation is enforced by Chrome itself.';
}

// --- Who else is deciding where links open ---------------------------------

/**
 * Ask the background whether another add-on is routing the same links.
 *
 * The background does the pinging, not this page: the reply has to survive the
 * page being closed halfway through, the answer is the same for every page that
 * asks, and a settings page holding message channels open to two other
 * extensions is a lot of machinery for one line of text.
 *
 * Never awaited by its callers. A peer that is installed but asleep costs the
 * two-second timeout, which is nothing on its own and is two seconds of a blank
 * settings page if anything waits for it.
 */
// Saving and rendering both ask, so two questions can be outstanding at once,
// and each waits on two other add-ons and can come back in either order. Without
// this the slower answer paints last and a warning the newer one had cleared
// comes back on screen.
let peerAsk = 0;

function checkPeers() {
  const ask = ++peerAsk;
  chrome.runtime
    .sendMessage({ type: 'linkward:peers' })
    // Silent on failure, and not shown as an error. Nothing here is a feature
    // somebody switched on; a census that could not run is indistinguishable
    // from a census that found nothing, and neither is worth a line on screen.
    .then(
      (peers) => {
        if (ask === peerAsk) showClash(peers);
      },
      () => {
        // Cleared, not left standing. This runs again after the master switch is
        // toggled, and the warning already on screen was measured against the
        // old setting — so keeping it means asserting a pair nothing has
        // confirmed since. A failed census says nothing, and nothing is what an
        // empty box says. Guarded like the success path: an older ask that
        // failed must not wipe a newer one's answer.
        if (ask === peerAsk) showClash(null);
      },
    );
}

function showClash(peers) {
  const box = $('clash');
  const list = $('clash-list');
  list.replaceChildren();
  // Cleared as well as hidden. This runs again after the switch is toggled, and
  // a stale warning left in a hidden box is one `hidden = false` away from
  // naming an add-on that stopped clashing ten seconds ago.
  if (!peers?.line) {
    $('clash-line').textContent = '';
    box.hidden = true;
    return;
  }
  $('clash-line').textContent = peers.line;
  for (const other of peers.clash ?? []) list.append(clashRow(other));
  box.hidden = false;
}

function clashRow(other) {
  const li = document.createElement('li');

  const who = document.createElement('span');
  who.className = 'who';
  // textContent, never innerHTML: every field here came from another extension.
  who.textContent = [other.name, other.version].filter(Boolean).join(' ');

  const shared = document.createElement('span');
  shared.className = 'shared';
  // Not "forget those below". Forgetting a host makes linkward ASK about it
  // instead of pinning it, and the picker is a redirect — so the other add-on's
  // new tab and linkward's question still add up to two tabs. "Never ask for" is
  // the only setting that makes linkward release the request untouched, which is
  // what has to happen for the pair to stop.
  shared.textContent = other.overlap?.length
    ? `Also opens ${other.overlap.join(', ')} — put those in "Never ask for" below to leave them ` +
      'to it, or switch one of the two off.'
    : 'No site in common with the list below, but it is holding the same requests, so a link ' +
      'either of you acts on can still open twice.';

  li.append(who, shared);
  return li;
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
  // Here rather than in init(), because these are the hosts the census compares:
  // pinning or forgetting one changes what overlaps, and a warning naming a site
  // that is no longer in this list is a warning nobody can act on. Every path
  // that changes a rule already ends here.
  checkPeers();
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
    $('ask-internal').checked = incoming.settings.askInternal;
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
    askInternal: $('ask-internal').checked,
    neverAsk: $('never')
      .value.split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  });
  say('Saved.');
  // After the write, not before: the switch and "Never ask for" are both things
  // that decide whether linkward is half of a pair, and the census has to read
  // what was just stored rather than what was on screen a moment ago.
  checkPeers();
}

function say(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

await init();
