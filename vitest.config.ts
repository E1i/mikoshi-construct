import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'scripts/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/fixtures/**'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
