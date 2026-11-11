import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const POLICY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../policy')

describe('the decisions modules live in one folder', () => {
  it.each(['decisions.ts', 'decisions-import.ts'])('scripts/policy/%s is gone', (file) => {
    expect(existsSync(path.join(POLICY, file))).toBe(false)
  })

  it.each(['index.ts', 'import.ts'])('scripts/policy/decisions/%s is there', (file) => {
    expect(existsSync(path.join(POLICY, 'decisions', file))).toBe(true)
  })
})
