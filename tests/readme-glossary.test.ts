import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IN_UNIVERSE } from './lore-vocabulary.js'

const README = readFileSync(path.join(import.meta.dirname, '../README.md'), 'utf8')

function glossary(): string {
  const start = README.indexOf('## Mikoshi, constructs and other words')
  const rest = README.slice(start)
  const end = rest.indexOf('\n## ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the glossary explains every in-universe word the tool prints', () => {
  it('names each one, so a reader never meets a term the README does not carry', () => {
    const table = glossary().toUpperCase()
    const unexplained = IN_UNIVERSE.filter(word => !table.includes(word.toUpperCase()))
    expect(unexplained).toEqual([])
  })

  it('reads the glossary and not the whole README, so a word mentioned in passing does not count as explained', () => {
    expect(glossary()).not.toContain('## Inspired by')
    expect(README).toContain('Soulkiller')
    expect(glossary()).toContain('| Braindance |')
  })
})
