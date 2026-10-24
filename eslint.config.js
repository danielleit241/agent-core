import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  ...tseslint.configs.recommended,
  {
    // Core may import only zod, node:crypto and relative files (spec 11.3).
    files: ['packages/core/**'],
    // The boundary test itself must import eslint.
    ignores: ['packages/core/src/boundary.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '^(?!zod$|node:crypto$|\\.).*' }] }],
    },
  },
)
