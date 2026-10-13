// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const EDITION_LITERAL_MESSAGE =
  'Do not branch on edition strings. Use the Ruleset abstraction (packages/fivetools/src/ruleset) or the edition policy instead.';

export default tseslint.config(
  {
    ignores: ['5etools-data/**', 'var/**', '**/dist/**', '**/.angular/**', '**/node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Edition checks belong in the ruleset/edition modules only
    files: ['**/*.ts'],
    ignores: ['packages/fivetools/src/ruleset/**', 'packages/fivetools/src/edition/**', '**/test/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^20(14|24)$/]", message: EDITION_LITERAL_MESSAGE },
        { selector: "SwitchCase > Literal[value=/^20(14|24)$/]", message: EDITION_LITERAL_MESSAGE },
        { selector: "BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^(classic|one)$/]", message: EDITION_LITERAL_MESSAGE },
      ],
    },
  },
);
