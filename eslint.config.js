import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'dist-firefox/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // .mjs too: the AMO fake is loaded with `node --import`, which wants an
    // unambiguous module extension, and without this it lands in the browser
    // block above and every `process` in it reads as undefined.
    files: ['tests/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
