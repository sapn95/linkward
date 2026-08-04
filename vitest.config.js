import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // The pure layer carries the risk of this extension — deciding whether to
      // interrupt somebody's navigation — so it is held to a higher bar than
      // the DOM glue around it.
      thresholds: {
        // The pure layer and the interception carry the risk — deciding whether
        // to interrupt somebody's navigation — and are held high.
        'src/lib/**': { statements: 95, branches: 85 },
        'src/background.js': { statements: 90, branches: 75 },
        // The two pages are DOM glue and are NOT covered yet. This number is
        // what the repo actually reaches today, not a target: raise it as
        // tests/pick.test.js and tests/options.test.js appear, and do not let it
        // drift down.
        'src/**': { statements: 60, branches: 65 },
      },
    },
  },
});
