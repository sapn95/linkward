// The store rejects a version that declares a permission it never uses, and
// nothing in the code would notice: an unused entry in optional_permissions is
// silent at runtime and only surfaces weeks later as a review rejection. So the
// two built manifests are checked against the one place that decides what is
// actually asked for.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchPermissions } from '../src/lib/containers.js';

const ROOT = process.cwd();
const read = (dir) => JSON.parse(readFileSync(join(ROOT, dir, 'manifest.json'), 'utf8'));

let chrome;
let firefox;

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT });
  execFileSync('node', ['scripts/build.mjs', '--firefox'], { cwd: ROOT });
  chrome = read('dist');
  firefox = read('dist-firefox');
}, 60_000);

describe('what each build asks the store to grant', () => {
  it('declares every optional permission the build will request', () => {
    // The other direction of the same rule: a permission the code requests but
    // the manifest does not declare is refused at runtime.
    expect(chrome.optional_permissions).toEqual(
      expect.arrayContaining(watchPermissions(false).permissions),
    );
    expect(firefox.optional_permissions).toEqual(
      expect.arrayContaining(watchPermissions(true).permissions),
    );
  });

  it('declares nothing beyond what it requests', () => {
    expect(chrome.optional_permissions.sort()).toEqual(watchPermissions(false).permissions.sort());
    expect(firefox.optional_permissions.sort()).toEqual(watchPermissions(true).permissions.sort());
  });

  it('keeps containers out of the Chrome build entirely', () => {
    // contextualIdentities is a Firefox API. On Chrome it is an unknown string
    // in the manifest and an unexplainable line in the store listing.
    expect(chrome.permissions).not.toContain('contextualIdentities');
    expect(chrome.permissions).not.toContain('cookies');
    expect(firefox.permissions).toContain('contextualIdentities');
  });

  it('does not promise Chrome users a container picker', () => {
    // The Web Store shows the manifest description verbatim as the summary.
    expect(chrome.description).not.toMatch(/container/i);
    expect(firefox.description).toMatch(/container/i);
  });

  it('gives the Firefox build the gecko id that AMO and storage.sync need', () => {
    expect(firefox.browser_specific_settings.gecko.id).toBe('linkward@sapn95.github.io');
    expect(chrome.browser_specific_settings).toBeUndefined();
  });

  it('names Android its own minimum, which is not the desktop one', () => {
    // data_collection_permissions is required by AMO. Desktop understood it
    // from 140, Android only from 142, and AMO warns about the mismatch on
    // every single submission. Raising the desktop minimum to match would lock
    // out desktop users on 140 and 141 for a key their browser already has.
    const { gecko, gecko_android: android } = firefox.browser_specific_settings;
    expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
    expect(gecko.strict_min_version).toBe('140.0');
    expect(android.strict_min_version).toBe('142.0');
    expect(Number.parseFloat(android.strict_min_version)).toBeGreaterThan(
      Number.parseFloat(gecko.strict_min_version),
    );
  });
});
