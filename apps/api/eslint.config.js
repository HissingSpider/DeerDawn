const globals = require('globals');
const pluginJs = require('@eslint/js');

module.exports = [
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs,
        ...globals.es2021
      },
      ecmaVersion: 12
    },
  },
  pluginJs.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['warn', {
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'caughtErrors': 'none',
      }],
      'no-console': 'off',
      'indent': 'off',
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always']
    }
  }
];
