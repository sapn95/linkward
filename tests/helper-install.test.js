// The installer the settings page hands over.
//
// "Run native/install.sh from the linkward repository" is an instruction for
// somebody who already has the repository, and most people who install this
// from the store never will. So the page builds the script itself, and these
// are the ways that script could be written and still not work.

import { describe, it, expect } from 'vitest';
import {
  installerFor,
  installerCommand,
  installerFileName,
  shellFor,
  HOST_NAME,
} from '../src/lib/helper-install.js';

const SOURCES = {
  host: "console.log('host');\nconst t = `a ${1} b`;\n",
  parse: "export const x = 'parse';\n",
};

describe('which installer a machine needs', () => {
  it('is PowerShell on Windows and a shell script everywhere else', () => {
    expect(shellFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('ps1');
    expect(shellFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15)')).toBe('sh');
    expect(shellFor('Mozilla/5.0 (X11; Linux x86_64)')).toBe('sh');
  });

  it('answers something for a user agent it cannot read', () => {
    // A missing answer would leave the page with no command to show at all,
    // which is worse than an answer that simply will not run.
    expect(shellFor('')).toBe('sh');
    expect(shellFor()).toBe('sh');
  });

  it('names the file and the command to match', () => {
    expect(installerCommand('sh')).toContain(installerFileName('sh'));
    expect(installerCommand('ps1')).toContain(installerFileName('ps1'));
  });
});

describe('what the installer writes', () => {
  const sh = installerFor('sh', SOURCES);
  const ps1 = installerFor('ps1', SOURCES);

  it('carries both files verbatim, backticks and all', () => {
    // The helper is JavaScript and full of $, backticks and ${}. A heredoc
    // with an unquoted delimiter would let the shell eat them and write a
    // file that no longer parses.
    expect(sh).toContain(SOURCES.host);
    expect(sh).toContain(SOURCES.parse);
    expect(ps1).toContain(SOURCES.host);
    expect(ps1).toContain(SOURCES.parse);
  });

  it('quotes the heredoc delimiters, so nothing inside is expanded', () => {
    expect(sh).toMatch(/<<'LINKWARD_HOST_EOF'/);
    expect(sh).toMatch(/<<'LINKWARD_PARSE_EOF'/);
    expect(ps1).toMatch(/@'\n/);
  });

  it('points the manifest at a wrapper, never at the .mjs', () => {
    // Firefox starts the helper with PATH=/usr/bin:/bin:/usr/sbin:/sbin —
    // measured, not assumed — so an env-node shebang finds nothing wherever
    // node actually lives, and the helper never starts. The symptom is "the
    // helper is not installed", which is both wrong and unfixable by
    // installing it again.
    expect(sh).toMatch(/"path": "\$LIB\/host\.sh"/);
    expect(sh).toContain('exec "$NODE"');
    expect(ps1).toContain('$Node');
    expect(ps1).toMatch(/path\s+=\s+\$Wrapper/);
  });

  it('resolves node once, at install time', () => {
    expect(sh).toContain('NODE="$(command -v node || true)"');
    expect(ps1).toContain('(Get-Command node -ErrorAction SilentlyContinue).Source');
  });

  it('allows exactly this extension and names the one host', () => {
    for (const script of [sh, ps1]) {
      expect(script).toContain(HOST_NAME);
      expect(script).toContain('linkward@sapn95.github.io');
    }
  });

  it('answers empty rather than half a script when a source is missing', () => {
    // Half an installer would write a helper that cannot import what it needs,
    // and the failure would land after the user had already run it.
    expect(installerFor('sh', { host: '', parse: 'x' })).toBe('');
    expect(installerFor('sh', { host: 'x' })).toBe('');
    expect(installerFor('sh')).toBe('');
    expect(installerFor('sh', null)).toBe('');
  });
});
