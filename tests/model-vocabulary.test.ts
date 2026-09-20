import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAIN_STAGES } from '../src/model/path.js'
import { ENFORCEMENT_LEVELS, ENTRY_AUTHORS, FACT_KINDS } from '../src/model/schema.js'
import { FACT_EVALUATIONS, MODEL_STATES } from '../src/model/state.js'

const DOCUMENT = readFileSync(path.join(import.meta.dirname, '../architecture/model.md'), 'utf8')

const VOCABULARIES: [string, readonly string[]][] = [
  ['fact kinds', FACT_KINDS],
  ['entry authors', ENTRY_AUTHORS],
  ['enforcement levels', ENFORCEMENT_LEVELS],
  ['fact evaluations', FACT_EVALUATIONS],
  ['model states', MODEL_STATES],
  ['chain stages', CHAIN_STAGES],
]

function unexplained(members: readonly string[]): string[] {
  return members.filter(member => !DOCUMENT.includes(`| \`${member}\` |`))
}

describe('architecture/model.md explains every word the model uses', () => {
  it.each(VOCABULARIES)('explains each of the %s, with what it means beside it', (_name, members) => {
    expect(unexplained(members)).toEqual([])
  })

  it('reads the enums from src/model, so a member added there and left undocumented turns red', () => {
    expect(unexplained([...MODEL_STATES, 'invented-state'])).toEqual(['invented-state'])
  })

  it('explains the points a reader cannot get from the code', () => {
    expect(DOCUMENT).toContain('### Why `unsupported` and `unknown` differ')
    expect(DOCUMENT).toContain('### Why there is no state and no confidence in the file')
    expect(DOCUMENT).toContain('An enforcement is never a bare level.')
    expect(DOCUMENT).toContain('declaration order in the model breaks the tie')
    expect(DOCUMENT).toContain('overwritten by the next `init`.**')
  })
})
