import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const POLICY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../policy')

describe('the decisions modules live in one folder', () => {
  it.each(['decisions.ts', 'decisions-import.ts'])('scripts/policy/%s is gone', (file) => {
    expect(existsSync(path.join(POLICY, file))).toBe(false)
  })

  it('scripts/policy/decisions/index.ts is there', () => {
    expect(existsSync(path.join(POLICY, 'decisions', 'index.ts'))).toBe(true)
  })

  it('scripts/policy/decisions/import.ts is gone: the bus imports nothing from owner-decisions.md', () => {
    expect(existsSync(path.join(POLICY, 'decisions', 'import.ts'))).toBe(false)
  })
})
