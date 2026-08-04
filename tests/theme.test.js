// Dark mode.
//
// Not a matter of taste: without `color-scheme` the browser paints its OWN
// controls light — a textarea, a dropdown, a tick box, the scrollbar — and none
// of them is touched by the variables the rest of the page uses. The result is
// a dark page with white boxes punched through it, which is what "supports dark
// mode" usually turns out to mean.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'src/pick/pick.css'), 'utf8');
const OPTIONS = readFileSync(join(process.cwd(), 'src/options/options.html'), 'utf8');
const PICK = readFileSync(join(process.cwd(), 'src/pick/pick.html'), 'utf8');

/** The declarations inside `@media (prefers-color-scheme: dark)`. */
const dark = CSS.slice(CSS.indexOf('prefers-color-scheme: dark'));

describe('the browser is told which scheme the page is in', () => {
  it('declares color-scheme, so native controls follow', () => {
    expect(CSS).toMatch(/color-scheme:\s*light dark/);
  });

  it('gives the tick boxes the accent colour rather than the platform blue', () => {
    expect(CSS).toMatch(/accent-color:/);
  });
});

describe('every colour comes from a variable', () => {
  const NAMES = ['--bg', '--fg', '--muted', '--border', '--accent', '--accent-bg'];

  it('re-states all of them for dark, so none falls back to the light value', () => {
    for (const name of NAMES) expect(dark).toContain(`${name}:`);
  });

  it('has no literal colour outside the two blocks that define them', () => {
    // A #hex anywhere else is a colour that cannot follow the scheme. The two
    // palettes and the container colours are the only places one belongs.
    const body = CSS.slice(CSS.indexOf('* {'));
    const literals = body.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(literals).toEqual([]);
  });

  it('styles the native controls it uses, in the page own colours', () => {
    for (const control of ['textarea', 'select']) {
      expect(CSS).toMatch(new RegExp(`${control}[^{]*\\{[^}]*background: var\\(--bg\\)`, 's'));
    }
  });
});

describe('both pages use the one stylesheet', () => {
  it('so a colour fixed in one is fixed in the other', () => {
    expect(OPTIONS).toContain('pick.css');
    expect(PICK).toContain('pick.css');
  });
});
