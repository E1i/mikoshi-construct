import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')

// Change only in an owner PR, by default only downward; PR D lowers it.
const AGENTS_MD_BUDGET = 29_800
// Change only in an owner PR, by default only downward; PR D lowers it.
const WINDOW_CORE_BUDGET = 3_700

function characters(file: string): number {
  return readFileSync(path.join(root, file), 'utf8').length
}

describe('the always-on text stays inside a fixed budget', () => {
  it('keeps AGENTS.md within its character budget', () => {
    expect(characters('AGENTS.md')).toBeLessThanOrEqual(AGENTS_MD_BUDGET)
  })

  it('keeps architecture/window-core.md within its character budget', () => {
    expect(characters('architecture/window-core.md')).toBeLessThanOrEqual(WINDOW_CORE_BUDGET)
  })

  it('names its version on a line of its own in window-core.md', () => {
    expect(readFileSync(path.join(root, 'architecture/window-core.md'), 'utf8').split('\n')).toContain('window-core v2')
  })
})
