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
      // Every metric has a floor, functions and lines included. Without one,
      // a whole function can be added and never called by a test while the
      // statement percentage barely moves — which is how the interception ended
      // up with a rule that nothing ever read back.
      thresholds: {
        // The pure layer and the interception carry the risk — deciding whether
        // to interrupt somebody's navigation — and are held high.
        'src/lib/**': { statements: 95, branches: 85, functions: 95, lines: 95 },
        'src/background.js': { statements: 90, branches: 85, functions: 80, lines: 95 },
        // Everything, pages included. Not a target — it is what the repo
        // reaches — so it may rise but must never be lowered to make a change
        // fit.
        'src/**': { statements: 90, branches: 80, functions: 80, lines: 90 },
      },
    },
  },
});
