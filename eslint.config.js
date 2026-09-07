// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '**/*.d.ts',
      'packaging/**',
      '*.config.js',
      'jest.config.js',
      'eslint.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Explicit project list rather than `projectService`: test files live outside the
        // emitting projects (which exclude them), so they are only covered by tsconfig.jest.json.
        project: ['./tsconfig.jest.json', './src/frontend/tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // `any` is permitted only with an explicit justification comment (CLAUDE.md).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Every privileged action must go through the helper client (T7).
          selector:
            "CallExpression[callee.property.name=/^(exec|execSync)$/][callee.object.name='child_process']",
          message:
            'Use the privileged helper client or execFile with an argv array. A shell is never permitted.',
        },
      ],
    },
  },

  // `src/shared` is bundled into the browser. Nothing Node-only may leak into it.
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'path',
                'child_process',
                'crypto',
                'os',
                'better-sqlite3',
                'express',
                'pino',
                '**/backend/**',
              ],
              message:
                'src/shared is consumed by the frontend bundle. It must contain no Node or backend imports (T2).',
            },
          ],
        },
      ],
    },
  },

  // Tests may reach for the pragmatic escape hatches.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  prettier,
);
