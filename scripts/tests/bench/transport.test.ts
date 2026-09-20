import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const LADDER = 'scripts/construct/implement.workflow.mjs'
const STAND = 'scripts/bench/architect-capture.workflow.mjs'

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8')
}

function literal(file: string, name: string): string {
  const found = new RegExp(`^const ${name} = ([\\s\\S]*?)$`, 'm').exec(read(file))
  return found?.[1] ?? ''
}

const SPEC_LITERAL = /^const SPEC = (\{[\s\S]+?^\})$/m

function specOf(file: string): string {
  return SPEC_LITERAL.exec(read(file))?.[1] ?? ''
}

describe('the stand calls the architect the way the ladder calls it', () => {
  it('carries the same schema, character for character', () => {
    expect(specOf(STAND)).not.toBe('')
    expect(specOf(STAND)).toBe(specOf(LADDER))
  })

  it('asks for the same effort the ladder gives the design step', () => {
    expect(literal(STAND, 'DESIGN_EFFORT')).toBe(literal(LADDER, 'DESIGN_EFFORT'))
  })

  it('passes the same agent type, schema and effort into the call', () => {
    for (const option of ['agentType: \'architect\'', 'effort: DESIGN_EFFORT', 'schema: SPEC'])
      expect(read(STAND), `the stand passes ${option}`).toContain(option)
  })

  it('runs the design step alone, with no implementer and no harness agent', () => {
    for (const other of ['implementer', 'harness'])
      expect(read(STAND)).not.toContain(`agentType: '${other}'`)
  })
})
