import path from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../vitest.config.js'

export default mergeConfig(base, defineConfig({
  test: {
    setupFiles: [path.join(import.meta.dirname, 'one-gib-disk.ts')],
  },
}))
