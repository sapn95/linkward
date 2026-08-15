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
    // Without this the test passes even when the importer drops the field and
    // hands back the default, which is exactly how documentation goes stale.
    expect(out.settings.rememberPrompt).toBe('ticked');
    expect(out.settings.askInternal).toBe(false);
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
    expect(README.match(/```mermaid/g) ?? []).toHaveLength(4);
  });
});

describe('what the README says about bookmarks and typed addresses', () => {
  const section = README.slice(
    README.indexOf('### Bookmarks and typed addresses'),
    README.indexOf('## Chrome'),
  ).replace(/\s+/g, ' ');

  it('exists under the anchor the options page links to', () => {
    // The tick box on the settings page points here. A dead fragment there is
    // worse than no link: it reads as a page that used to explain itself.
    expect(section).not.toBe('');
    expect(readFileSync(join(process.cwd(), 'src/options/options.html'), 'utf8')).toContain(
      '#bookmarks-and-typed-addresses',
    );
  });

  it('names all four things that look the same, not just the two reported', () => {
    for (const one of ['a bookmark', 'typed or pasted', 'search from the address bar']) {
      expect(section).toContain(one);
    }
  });

  it('says why the field that would settle it arrives late', () => {
    // Somebody will suggest transitionType. The answer has to survive being
    // asked again in six months — and half of it is now "we use it anyway".
    expect(section).toMatch(/transitionType/);
    expect(section).toMatch(/only on `webNavigation\.onCommitted`/i);
    expect(section).toMatch(/after the request has already gone/i);
  });

  it('says the two builds answer it differently, and why that is not a fudge', () => {
    // The asymmetry is the design, not an oversight, so it is stated before
    // either half is described.
    expect(section).toMatch(/two builds therefore answer this\s+differently/i);
    expect(section).toMatch(/best evidence its browser actually offers/i);
  });

  it('says Chromium takes the browser at its word, and what that costs', () => {
    expect(section).toMatch(/Chromium waits for `onCommitted` and believes it/i);
    expect(section).toMatch(/only ever raced the navigation/i);
    expect(section).toMatch(/costs a page flash/i);
    // The direction an unknown transition errs in is the whole safety argument.
    expect(section).toMatch(/names what to \*{0,2}exclude/i);
  });

  it('says Firefox falls back to a proxy, and calls it one', () => {
    expect(section).toMatch(/was the browser \*{0,2}already in front/i);
    expect(section).toMatch(/windows\.onFocusChanged/);
    expect(section).toMatch(/proxy, not the fact/i);
    // And that the two named failures are Firefox's alone, or a Chromium user
    // reads limits that do not apply to them.
    expect(section).toMatch(/Neither applies to the Chromium\s+build/i);
  });

  it('keeps the report that forced the split, because it explains the word proxy', () => {
    // Whitespace-normalised, and this one is a BLOCKQUOTE — the `>` markers
    // survive the normalising, so a pattern that straddles a line break has to
    // allow for them. Easier to match inside one line.
    expect(section).toMatch(/paste it into the address bar/i);
    expect(section).toMatch(/exactly what a hand-off looks like/i);
    expect(section).toMatch(/separates those two/i);
  });

  it('names the two cases it gets wrong rather than leaving them to be found', () => {
    // A limit somebody discovers themselves reads as a bug. The same limit
    // written down reads as a decision.
    expect(section).toMatch(/without raising the browser/i);
    expect(section).toMatch(/open -g/);
    expect(section).toMatch(/inside a second and a half/i);
  });

  it('says why a window switch counts, instead of leaving it looking careless', () => {
    // It is the obvious thing to "fix", and fixing it trades a bounded
    // annoyance for a silent, unbounded one. Written down, or somebody removes
    // it in six months — quite possibly me.
    expect(section).toMatch(/the _loss_ of focus is the half neither browser reports/i);
    expect(section).toMatch(/Bounded and annoying beats unbounded and silent/i);
    // Cited, not asserted. The claim is the whole reason for a design somebody
    // will otherwise read as sloppy.
    expect(section).toContain('bugzilla.mozilla.org/show_bug.cgi?id=1391942');
  });

  it('says what happens on Android, which is a supported target', () => {
    // gecko_android is in the manifest. No windows to focus there, so the API
    // is absent and the rule never fires — worth saying, because "it does not
    // work on my phone" would otherwise read as a bug.
    expect(section).toMatch(/Firefox for Android/);
    expect(section).toMatch(/no windows to focus/i);
  });

  it('says which way it errs when it cannot tell, and that that is deliberate', () => {
    expect(section).toMatch(/err towards \*{0,2}asking/i);
    expect(section).toMatch(/storage\.session/);
  });

  it('says the setting exists and that it is off', () => {
    expect(section).toMatch(/Ask about bookmarks and addresses I type myself/);
    expect(section).toMatch(/It is off\./);
  });
});

describe('what the README claims about Chromium profiles', () => {
  // Whitespace-normalised: Markdown wraps at 80 columns, so a sentence to be
  // matched is regularly split across two lines.
  const section = README.slice(README.indexOf('### Chromium profiles')).replace(/\s+/g, ' ');

  it('states the limit as a wall, not as something that is coming', () => {
    // "Not supported yet" would be a promise nobody can keep: the boundary is
    // below the API, not a gap in it.
    expect(section).toMatch(/No extension can open a tab in another Chromium profile/);
    // And it says why that phrasing was chosen, rather than leaving the reader
    // to wonder whether this is a gap somebody is working on.
    expect(section).toMatch(/would imply it is coming/i);
  });

  it('gives the reason, so the claim can be checked rather than believed', () => {
    expect(section).toMatch(/chrome\.tabs\.create/);
    expect(section).toMatch(/no profile parameter/i);
  });

  it('says what does work instead, with its price', () => {
    for (const route of ['--profile-directory', 'native-messaging host', 'Choosy']) {
      expect(section).toContain(route);
    }
  });

  it('answers the question everyone asks: can the browser not call itself?', () => {
    // It can. The reason that does not help is specific, and losing it means
    // relitigating this every time somebody has the same good idea.
    expect(section).toMatch(/an extension is not a process/i);
    expect(section).toMatch(/custom URL scheme/i);
    // The two facts that kill the shortcut: it still needs an installer, and
    // Chromium prompts every time because the scheme list is compiled in.
    expect(section).toMatch(/not the installer/i);
    expect(section).toMatch(/prompts \*\*every single time\*\*|every single time/i);
    expect(section).toMatch(/AutoLaunchProtocolsFromOrigins/);
  });

  it('says why linkward ships none of them', () => {
    // A native host would trade the one thing this extension has — nothing to
    // install — for a feature only half its users could ever get.
    expect(section).toMatch(/ships none of these on purpose/i);
  });
});

describe('what the README says about container extensions', () => {
  const section = README.slice(README.indexOf('### Chromium profiles')).replace(/\s+/g, ' ');

  it('separates them from the profile question rather than lumping them in', () => {
    // People arrive looking for one and find the other. Saying "there is
    // nothing" would be wrong; saying "use one of those" would be wronger.
    expect(section).toMatch(/isolated sessions inside one profile/i);
    expect(section).toMatch(/cannot give you is \*{0,2}another profile/i);
  });

  it('names them, and is fair about what they do and do not isolate', () => {
    expect(section).toMatch(/SessionBox/);
    expect(section).toMatch(/fingerprint/i);
    // Firefox's own containers share that ceiling; not saying so would be
    // selling our side of it.
    expect(section).toMatch(/Firefox containers have the same ceiling/i);
  });

  it('says why linkward will not become one', () => {
    expect(section).toMatch(/does not do this and will not/i);
  });
});

describe('the Firefox side of the same question', () => {
  const section = README.slice(README.indexOf('### If Firefox has no containers yet')).replace(
    /\s+/g,
    ' ',
  );

  it('names the add-on people actually need, without claiming to need it', () => {
    // Containers are built in; making one is not. Not naming Multi-Account
    // Containers leaves an empty picker and no idea why.
    expect(section).toMatch(/built into Firefox/i);
    expect(section).toMatch(/Multi-Account Containers/);
    expect(section).toMatch(/does not depend on it and does not talk to it/i);
  });
});

describe('how the README says linkward relates to container extensions', () => {
  const section = README.slice(README.indexOf('### Chromium profiles')).replace(/\s+/g, ' ');

  it('offers the never-ask list rather than an integration', () => {
    // It is the only honest interop story: nothing is wired, so nothing can
    // break, and the hosts somebody else manages simply never come up.
    expect(section).toMatch(/put the hosts it manages on \*\*the never-ask list\*\*/i);
    expect(section).toMatch(/nothing to wire up/i);
  });

  it('does not claim support that was never built or tested', () => {
    // "Supported" would promise something nobody has checked.
    expect(section).not.toMatch(/we support SessionBox|officially supported/i);
    expect(section).toMatch(/no `externally_connectable` surface/i);
  });
});

describe('the keyboard, as documented', () => {
  const section = README.slice(
    README.indexOf('## The keyboard'),
    README.indexOf('## Why it asked'),
  );

  it('lists every key the picker actually handles', async () => {
    // A shortcut table that has drifted is worse than none: somebody presses
    // the key, nothing happens, and they stop trusting the rest of the page.
    const source = readFileSync(join(process.cwd(), 'src/pick/pick.js'), 'utf8');
    for (const key of ['Enter', 'Escape']) expect(source).toContain(`case '${key}'`);
    expect(section).toMatch(/`1`–`9`/);
    expect(section).toMatch(/`Enter`/);
    expect(section).toMatch(/`c`/);
    expect(section).toMatch(/`Esc`/);
  });

  it('says that modifiers are left to the browser', () => {
    expect(section).toMatch(/⌘, Ctrl or Alt held is left alone/i);
  });
});

describe('the Mermaid blocks GitHub has to render', () => {
  const blocks = [...README.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

  it('finds all four', () => {
    expect(blocks).toHaveLength(4);
  });

  it('has no semicolon inside a sequence diagram', () => {
    // A semicolon SEPARATES STATEMENTS there, so one inside a Note ends the
    // note and the rest is a parse error. GitHub then shows "Unable to render
    // rich display" and the whole diagram is a wall of text — which is how this
    // shipped, in a file nobody re-reads after writing.
    for (const block of blocks.filter((b) => b.includes('sequenceDiagram'))) {
      expect(block).not.toContain(';');
    }
  });

  it('quotes every flowchart label that carries punctuation', () => {
    // Unquoted (), :, — and the rest end a node early in flowcharts too.
    for (const block of blocks.filter((b) => b.includes('flowchart'))) {
      for (const label of block.match(/\[[^\]]*\]|\{[^}]*\}/g) ?? []) {
        const inner = label.slice(1, -1);
        if (/[(),:;]/.test(inner)) expect(inner.startsWith('"')).toBe(true);
      }
    }
  });
});

describe('the diagrams in dark mode', () => {
  const blocks = [...README.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

  it('tints a sequence-diagram rect rather than painting over it', () => {
    // A `rect` sets a background and NOT the text colour, which comes from
    // whichever theme GitHub is in. An opaque light fill therefore renders light
    // grey text on near-white in dark mode: the diagram was unreadable, and the
    // light-mode preview it was written against showed nothing wrong.
    for (const rect of README.match(/rect rgba?\([^)]*\)/g) ?? []) {
      expect(rect).toMatch(/^rect rgba\(/);
      const alpha = Number(rect.match(/,\s*([\d.]+)\s*\)$/)?.[1]);
      expect(alpha).toBeLessThanOrEqual(0.2);
    }
  });

  it('never sets a fill in a flowchart without setting a colour with it', () => {
    // Same trap, one diagram type over: fill alone leaves the label to the
    // theme, and the pair has to work in both.
    for (const block of blocks) {
      for (const style of block.match(/style \w+ [^\n]*/g) ?? []) {
        if (style.includes('fill:')) expect(style).toMatch(/color:/);
      }
    }
  });
});
