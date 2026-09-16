// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // `allowDefaultProject` covers the config files at the repo root,
        // which are not part of tsconfig's `include` but still get linted.
        // vitest.config.ts is already covered by tsconfig's `include`; only
        // this file needs the default-project escape hatch.
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are fine when prefixed with `_`. Express error handlers
      // must declare all four parameters even when `next` is unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Floating promises in a request handler mean an unhandled rejection
      // that bypasses the error middleware entirely.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // `any` disables exactly the checks this codebase relies on.
      '@typescript-eslint/no-explicit-any': 'error',

      // Reading process.env outside config/env.ts defeats boot-time validation.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from src/config/env.ts, never process.env directly.',
        },
      ],

      // Application code logs through pino, so context fields and redaction
      // are applied. The CLI scripts below are exempt.
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // The config module and scripts are the only places allowed to touch
  // process.env / the console: they run before the logger exists.
  {
    files: ['src/config/env.ts', 'src/db/migrate.ts', 'src/db/bootstrap.ts', 'eslint.config.js'],
    rules: {
      'no-restricted-properties': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
    },
  },

  prettier,
);
