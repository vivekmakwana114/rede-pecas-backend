import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // tsconfig.json has strict: false and the codebase intentionally uses `any`
      // at API/DB response boundaries — keep this as signal, not a hard failure.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
