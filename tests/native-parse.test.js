// What counts as a browser, on three platforms from one machine.
//
// The helper claims macOS, Linux and Windows and can only ever run on one of
// them. So the part that decides is pure and takes text, and these fixtures are
// the real shapes: an Info.plist converted to JSON, a .desktop entry, and the
// output of `reg query …\StartMenuInternet`.

import { describe, it, expect } from 'vitest';
import {
  macBrowser,
  desktopBrowser,
  windowsBrowsers,
  tidy,
  macIconFile,
  desktopIconPath,
} from '../native/parse.mjs';

describe('macOS', () => {
  const plist = (schemes, over = {}) => ({
    CFBundleIdentifier: 'com.example.browser',
    CFBundleName: 'Example',
    CFBundleURLTypes: [{ CFBundleURLSchemes: schemes }],
    ...over,
  });

  it('takes an app that claims http, https and file', () => {
    expect(macBrowser(plist(['http', 'https', 'file']), '/Applications/X.app')).toEqual({
      id: 'com.example.browser',
      name: 'Example',
      path: '/Applications/X.app',
    });
  });

  it('refuses one that claims the schemes but not file', () => {
    // Measured, not assumed: iTerm2, Hammerspoon and VLC all claim http and
    // https, and Launch Services agrees they are http handlers. None of them
    // claims file. A browser opens a local page too.
    expect(macBrowser(plist(['http', 'https']), '/Applications/X.app')).toBeNull();
    expect(macBrowser(plist(['http', 'file']), '/Applications/X.app')).toBeNull();
  });

  it('leaves Firefox out', () => {
    const info = plist(['http', 'https', 'file'], { CFBundleIdentifier: 'org.mozilla.firefox' });
    expect(macBrowser(info, '/Applications/Firefox.app')).toBeNull();
  });

  it('falls back to the app name when the bundle has none', () => {
    const info = plist(['http', 'https', 'file'], { CFBundleName: '  ' });
    expect(macBrowser(info, '/Applications/X.app', 'X').name).toBe('X');
  });

  it('answers null rather than throwing on junk', () => {
    expect(macBrowser(null, '/x')).toBeNull();
    expect(macBrowser({ CFBundleURLTypes: 'nope' }, '/x')).toBeNull();
    expect(macBrowser(plist(['http', 'https', 'file']), '/x', '')).not.toBeNull();
  });
});

describe('Linux', () => {
  const entry = (mime, over = '') =>
    `[Desktop Entry]\nName=Example\nExec=/usr/bin/example %U\nMimeType=${mime}\n${over}`;
  const BROWSER = 'text/html;x-scheme-handler/http;x-scheme-handler/https;';

  it('takes an entry that handles both schemes and local html', () => {
    expect(desktopBrowser(entry(BROWSER), 'example')).toEqual({
      id: 'example',
      name: 'Example',
      path: '/usr/bin/example',
    });
  });

  it('refuses a player that claims the schemes without text/html', () => {
    expect(
      desktopBrowser(entry('x-scheme-handler/http;x-scheme-handler/https;'), 'mpv'),
    ).toBeNull();
  });

  it('matches each type whole, so http is not found inside https', () => {
    expect(desktopBrowser(entry('text/html;x-scheme-handler/https;'), 'half')).toBeNull();
  });

  it('strips the field codes rather than filling them', () => {
    const body = entry(BROWSER).replace(
      'Exec=/usr/bin/example %U',
      'Exec=/usr/bin/example --new %f',
    );
    expect(desktopBrowser(body, 'example').path).toBe('/usr/bin/example --new');
  });

  it('respects NoDisplay and leaves Firefox out', () => {
    expect(desktopBrowser(entry(BROWSER, 'NoDisplay=true\n'), 'example')).toBeNull();
    expect(desktopBrowser(entry(BROWSER), 'firefox')).toBeNull();
    expect(desktopBrowser(entry(BROWSER).replace('Name=Example', 'Name=Firefox'), 'x')).toBeNull();
  });

  it('reads the [Desktop Entry] group and not an action group', () => {
    // An action group carries its own Exec, and it is not the one that opens a
    // URL — a "New Private Window" action would be started instead.
    const body = `${entry(BROWSER)}\n[Desktop Action new-private]\nName=Private\nExec=/usr/bin/example --private\n`;
    expect(desktopBrowser(body, 'example').path).toBe('/usr/bin/example');
  });

  it('answers null rather than throwing on junk', () => {
    expect(desktopBrowser('', 'x')).toBeNull();
    expect(desktopBrowser('nothing here', 'x')).toBeNull();
    expect(desktopBrowser(entry(BROWSER).replace(/Exec=.*/, 'Exec='), 'x')).toBeNull();
  });
});

describe('Windows', () => {
  const KEYS = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB',
  ].join('\r\n');

  const read = (key) => {
    if (key.endsWith('shell\\open\\command')) {
      return '\r\n    (Default)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\chrome.exe"\r\n';
    }
    return '\r\n    (Default)    REG_SZ    Google Chrome\r\n';
  };

  it('reads the browsers Windows itself registered', () => {
    // StartMenuInternet is where a browser registers to be offered as an
    // internet client, so reading it IS the capability check.
    expect(windowsBrowsers(KEYS, read)).toEqual([
      {
        id: 'Google Chrome',
        name: 'Google Chrome',
        path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
      },
    ]);
  });

  it('ignores the parent key and anything not a browser key', () => {
    expect(
      windowsBrowsers('HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet', read),
    ).toEqual([]);
  });

  it('takes an unquoted command and drops its switches', () => {
    const plain = (key) =>
      key.endsWith('command')
        ? '\r\n    (Default)    REG_SZ    C:\\browser.exe --new-window\r\n'
        : '';
    expect(windowsBrowsers(KEYS, plain)[0].path).toBe('C:\\browser.exe');
  });

  it('falls back to the key name when there is no display name', () => {
    const noName = (key) =>
      key.endsWith('command') ? '\r\n    (Default)    REG_SZ    "C:\\b.exe"\r\n' : '';
    expect(windowsBrowsers(KEYS, noName)[0].name).toBe('Google Chrome');
  });
});

describe('one list out of all of them', () => {
  it('deduplicates on id and sorts by name', () => {
    const rows = tidy([
      { id: 'b', name: 'Zebra', path: '/z' },
      { id: 'a', name: 'Alpha', path: '/a' },
      { id: 'b', name: 'Zebra (copy)', path: '/z2' },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zebra']);
  });

  it('drops an entry with no id', () => {
    expect(tidy([null, {}, { id: '', name: 'x' }])).toEqual([]);
  });
});

// An icon is decoration, so every one of these answers '' rather than a guess.
// A guessed path is a file read that fails, once per browser, on a helper the
// user cannot see the output of.
describe('the icon a bundle names', () => {
  it('adds the suffix when the plist leaves it off', () => {
    // Both are legal and both ship: Safari names `AppIconUpdated`, Chrome
    // names `app.icns`.
    expect(macIconFile({ CFBundleIconFile: 'AppIconUpdated' })).toBe('AppIconUpdated.icns');
  });

  it('keeps the suffix the plist already has, in either case', () => {
    expect(macIconFile({ CFBundleIconFile: 'app.icns' })).toBe('app.icns');
    expect(macIconFile({ CFBundleIconFile: 'App.ICNS' })).toBe('App.ICNS');
  });

  it('answers nothing for a bundle that names no icon', () => {
    expect(macIconFile({})).toBe('');
    expect(macIconFile(null)).toBe('');
    expect(macIconFile({ CFBundleIconFile: '   ' })).toBe('');
  });
});

describe('the icon a .desktop entry names', () => {
  const entry = (icon) => `[Desktop Entry]\nName=Browser\nIcon=${icon}\n`;

  it('takes an absolute path', () => {
    expect(desktopIconPath(entry('/usr/share/icons/b.png'))).toBe('/usr/share/icons/b.png');
  });

  it('refuses a bare theme name rather than resolving the icon theme', () => {
    // The spec allows it. Walking the theme is a search this helper has no
    // business doing, and its failure would be a broken image, not no image.
    expect(desktopIconPath(entry('firefox'))).toBe('');
  });

  it('reads only the [Desktop Entry] section', () => {
    const withAction = `[Desktop Action new]\nIcon=/wrong.png\n[Desktop Entry]\nIcon=/right.png\n`;
    expect(desktopIconPath(withAction)).toBe('/right.png');
  });

  it('answers nothing for an entry with no icon and for no entry at all', () => {
    expect(desktopIconPath('[Desktop Entry]\nName=Browser\n')).toBe('');
    expect(desktopIconPath('[Desktop Action new]\nIcon=/x.png\n')).toBe('');
    expect(desktopIconPath('')).toBe('');
  });
});
