import { defineConfig } from 'vitest/config'

const base = { globals: true, environment: 'node', testTimeout: 30_000 } as const

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...base,
          name: 'unit',
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.db.test.ts', 'e2e/**'],
        },
      },
      {
        test: {
          ...base,
          name: 'db',
          include: ['**/*.db.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
      {
        test: {
          ...base,
          name: 'e2e',
          include: ['e2e/**/*.e2e.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
})
