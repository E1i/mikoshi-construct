import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'scripts/tests/**/*.test.ts'],
    environment: 'node',
  },
})
