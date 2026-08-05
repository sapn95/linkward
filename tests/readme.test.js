// The README documents the settings file, and a documented shape that has
// drifted from the code is worse than none: somebody hand-edits a file to match
// the page and the import refuses it. So the example in the README is fed
// through the real importer.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromTransfer, FORMAT, VERSION } from '../src/lib/transfer.js';

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

/** The first ```json block under the settings-file heading. */
const example = (() => {
  const at = README.indexOf('## The settings file');
  const open = README.indexOf('```json', at);
  const start = README.indexOf('\n', open) + 1;
  return README.slice(start, README.indexOf('```', start));
})();

describe('the documented settings file', () => {
  it('is valid JSON', () => {
    expect(() => JSON.parse(example)).not.toThrow();
  });

  it('is accepted by the importer, exactly as printed', () => {
    const out = fromTransfer(JSON.parse(example));
    expect(out.settings.neverAsk).toEqual(['intranet.example', 'mail.example']);
    expect(out.rules['docs.example.com']).toEqual({
      container: 'Work',
      cookieStoreId: 'firefox-container-2',
    });
    expect(out.rules['shop.example'].plain).toBe(true);
  });

  it('names the format and version the code actually expects', () => {
    const parsed = JSON.parse(example);
    expect(parsed.format).toBe(FORMAT);
    expect(parsed.version).toBe(VERSION);
  });

  it('does not print fields the importer refuses to read', () => {
    // Documenting `enabled` would invite somebody to add it and wonder why
    // nothing happens.
    expect(example).not.toMatch(/"enabled"/);
    expect(example).not.toMatch(/"lastContainer"/);
  });
});

describe('the diagrams', () => {
  it('are Mermaid, which GitHub renders inline', () => {
    // No committed SVG to keep in step with the source, because this repo is
    // read on GitHub and GitHub draws the fenced block itself.
    expect(README.match(/```mermaid/g) ?? []).toHaveLength(3);
  });
});
