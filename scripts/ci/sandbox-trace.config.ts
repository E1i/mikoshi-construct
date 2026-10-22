import path from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vitest.config.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export default mergeConfig(base, defineConfig({
  root: REPO_ROOT,
  test: { setupFiles: [path.join(import.meta.dirname, 'sandbox-trace.ts')] },
}))
