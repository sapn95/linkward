// Builds dist/ (Chrome) and dist-firefox/ from the same src/.
//
// There is no bundler and there are no runtime dependencies: the source under
// src/ IS the artifact, and the only thing this script does is copy it and
// rewrite the manifest for the target browser. That is deliberate — an
// extension that intercepts navigations should be readable end to end by
// whoever reviews it, in the store and out of it.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const flags = new Set(process.argv.slice(2));
const firefox = flags.has('--firefox');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, firefox ? 'dist-firefox' : 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'src'), OUT, { recursive: true });

const manifestPath = join(OUT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;

if (firefox) {
  // Firefox's stable MV3 background is an event page, not a service worker, and
  // a gecko id is required for storage.sync and for AMO signing.
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: {
      id: 'linkward@sapn95.github.io',
      // data_collection_permissions is required by AMO and needs Firefox 140+.
      // linkward sends nothing anywhere.
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    // Android reached the same key two releases later than desktop, and AMO
    // warns about the mismatch on every submission. Its own minimum is the
    // honest fix: raising the desktop one to 142 would lock out desktop users
    // on 140 and 141 for a key their browser already understands.
    gecko_android: {
      strict_min_version: '142.0',
    },
  };
  // Firefox holds the request itself, so it never reaches for webNavigation.
  manifest.optional_permissions = manifest.optional_permissions.filter(
    (p) => p !== 'webNavigation',
  );
} else {
  // Containers are a Firefox feature. Shipping the permission to Chrome would
  // be an unknown string in the manifest and an unexplainable line in the store
  // listing, for an API that does not exist there.
  manifest.permissions = manifest.permissions.filter(
    (p) => p !== 'contextualIdentities' && p !== 'cookies',
  );
  // The Web Store shows this verbatim as the item's summary, so it must not
  // promise a container picker to a browser that has no containers.
  manifest.description =
    'Asks where a link should open, before it opens. Or copies the URL and opens nothing.';
  // Chrome MV3 has no blocking webRequest, so the Chrome build asks AFTER the
  // navigation starts rather than before it, through webNavigation — see
  // docs/architecture.md. Neither webRequest permission is ever requested
  // there, and the store rejects a version that declares what it does not use.
  manifest.optional_permissions = manifest.optional_permissions.filter(
    (p) => p !== 'webRequestBlocking' && p !== 'webRequest',
  );
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${firefox ? 'dist-firefox' : 'dist'}/ for v${pkg.version}`);

if (flags.has('--zip')) {
  const zipName = firefox ? `linkward-firefox-v${pkg.version}.zip` : `linkward-v${pkg.version}.zip`;
  const zipPath = join(ROOT, zipName);
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: OUT, stdio: 'inherit' });
  console.log(`packaged ${zipName}`);
}

if (!existsSync(join(OUT, 'icons', 'icon-128.png'))) {
  console.warn('NOTE: icons are still placeholders');
}
