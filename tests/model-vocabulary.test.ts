import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAIN_STAGES } from '../src/model/path.js'
import { ENFORCEMENT_LEVELS, ENTRY_AUTHORS, FACT_KINDS, HYPOTHESIS_PROPERTIES } from '../src/model/schema.js'
import { FACT_EVALUATIONS, MODEL_STATES } from '../src/model/state.js'

const DOCUMENT = readFileSync(path.join(import.meta.dirname, '../architecture/model.md'), 'utf8')

const VOCABULARIES: [string, readonly string[]][] = [
  ['fact kinds', FACT_KINDS],
  ['entry authors', ENTRY_AUTHORS],
  ['enforcement levels', ENFORCEMENT_LEVELS],
  ['fact evaluations', FACT_EVALUATIONS],
  ['model states', MODEL_STATES],
  ['chain stages', CHAIN_STAGES],
  ['hypothesis properties', HYPOTHESIS_PROPERTIES],
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

  it('reads the hypothesis properties from src/model/schema.ts, so a property added there and left undocumented turns red', () => {
    expect(unexplained([...HYPOTHESIS_PROPERTIES, 'inventedProperty'])).toEqual(['inventedProperty'])
  })

  it('says what a hypothesis records about the tree it was read from, in the three ways a reader gets it wrong', () => {
    expect(DOCUMENT).toContain('### `baseClean` is about the tree read, never the tree left behind')
    expect(DOCUMENT).toContain('### `baseClean` is a claim, not a measurement')
    expect(DOCUMENT).toContain('### Hypotheses with different bases belong together')
    expect(DOCUMENT).toContain('before the run began writing')
    expect(DOCUMENT).toContain('Nothing in this tool verifies `baseClean`.')
  })

  it('explains the points a reader cannot get from the code', () => {
    expect(DOCUMENT).toContain('### Why `unsupported` and `unknown` differ')
    expect(DOCUMENT).toContain('### Why there is no state and no confidence in the file')
    expect(DOCUMENT).toContain('An enforcement is never a bare level.')
    expect(DOCUMENT).toContain('declaration order in the model breaks the tie')
    expect(DOCUMENT).toContain('overwritten by the next `init`.**')
  })
})
