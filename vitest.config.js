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
        // Everything, pages included. Not a target — it is what the repo
        // reaches — so it may rise but must never be lowered to make a change
        // fit.
        'src/**': { statements: 90, branches: 80 },
      },
    },
  },
});
