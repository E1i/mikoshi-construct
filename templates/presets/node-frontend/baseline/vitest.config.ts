import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'app', include: ['tests/**/*.test.ts'], environment: 'happy-dom' } },
      { test: { name: 'scripts', include: ['scripts/tests/**/*.test.ts'], environment: 'node' } },
    ],
  },
})
