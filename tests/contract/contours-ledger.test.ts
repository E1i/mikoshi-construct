import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readContourSchema, schemaId, violations } from '../../scripts/contract/contours.js'
import { LEDGER_FIELDS, parseLedgerLine } from '../../src/commands/cost/ledger.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SCHEMA_PATH = 'contract/contours/ledger-row.schema.json'
const schema = readContourSchema('ledger-row')

const BASE = {
  run: 'wf_abc',
  at: '2026-09-24T10:00:00.000Z',
  task: 't',
  effort: 'medium',
  status: 'done',
  rung: 'medium',
  attempts: [{ rung: 1, effort: 'medium', outcome: 'passed', reason: '' }],
  agents: 3,
  tokens: 1,
  toolUses: 2,
  seconds: 3,
}

function row(changes: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...BASE, ...changes }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined)
      delete merged[key]
  }
  return merged
}

const HASH_FAULTS: { name: string, field: string, row: Record<string, unknown> }[] = [
  { name: 'an agreed hash of 63 hex', field: 'agreedSha256', row: row({ agreedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) },
  { name: 'an args hash in capitals', field: 'argsSha256', row: row({ argsSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }) },
  { name: 'an args hash that is a number', field: 'argsSha256', row: row({ argsSha256: 7 }) },
]

const SKETCH_SHA = '0123456789abcdef0123456789abcdef01234567'

const SKETCH_FAULTS: { name: string, row: Record<string, unknown> }[] = [
  { name: 'a sketch of three letters', row: row({ sketch: 'abc' }) },
  { name: 'a sketch that is a number', row: row({ sketch: 7 }) },
  { name: 'a sketch of 39 hex', row: row({ sketch: SKETCH_SHA.slice(1) }) },
  { name: 'a sketch in capitals', row: row({ sketch: SKETCH_SHA.toUpperCase() }) },
  { name: 'a sketch of 64 hex', row: row({ sketch: 'a'.repeat(64) }) },
  { name: 'an empty sketch', row: row({ sketch: '' }) },
  { name: 'a sketch of 40 characters that are not hex', row: row({ sketch: 'g'.repeat(40) }) },
]

const ROWS: { name: string, row: Record<string, unknown>, holds: boolean }[] = [
  { name: 'done', row: row({}), holds: true },
  { name: 'an absent run', row: row({ run: undefined }), holds: true },
  { name: 'stopped by a human', row: row({ status: 'stopped', cause: 'human' }), holds: true },
  { name: 'stopped by the environment', row: row({ status: 'stopped', cause: 'environment' }), holds: true },
  { name: 'failed on the task', row: row({ status: 'failed', cause: 'task' }), holds: true },
  { name: 'failed with no cause recorded', row: row({ status: 'failed' }), holds: true },
  { name: 'tokens unknown', row: row({ tokens: 'unknown' }), holds: true },
  { name: 'tokens from the runtime', row: row({ tokensSource: 'runtime' }), holds: true },
  { name: 'both hashes', row: row({ agreedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', argsSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), holds: true },
  { name: 'only the agreed hash', row: row({ agreedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), holds: true },
  { name: 'only the args hash', row: row({ argsSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), holds: true },
  { name: 'a sketch sha', row: row({ sketch: SKETCH_SHA }), holds: true },
  { name: 'a sketch of null', row: row({ sketch: null }), holds: true },
  { name: 'a sketch sha on a stopped run', row: row({ status: 'stopped', cause: 'human', sketch: SKETCH_SHA }), holds: true },
  { name: 'an unknown status', row: row({ status: 'ascended' }), holds: true },
  { name: 'an unknown top-level field', row: row({ ghost: true }), holds: true },
  { name: 'a run that is a number', row: row({ run: 7 }), holds: false },
  { name: 'an empty run', row: row({ run: '' }), holds: false },
  { name: 'stopped with no cause', row: row({ status: 'stopped' }), holds: false },
  { name: 'stopped with a task cause', row: row({ status: 'stopped', cause: 'task' }), holds: false },
  { name: 'a cause on done', row: row({ cause: 'human' }), holds: false },
  { name: 'failed with a human cause', row: row({ status: 'failed', cause: 'human' }), holds: false },
  { name: 'tokens as a string', row: row({ tokens: '5' }), holds: false },
  { name: 'a token source nobody declared', row: row({ tokensSource: 'guess' }), holds: false },
  ...SKETCH_FAULTS.map(({ name, row: value }) => ({ name, row: value, holds: false })),
  ...HASH_FAULTS.map(({ name, row: value }) => ({ name, row: value, holds: false })),
  { name: 'no at', row: row({ at: undefined }), holds: false },
  { name: 'no attempts', row: row({ attempts: undefined }), holds: false },
  { name: 'an attempt with no reason', row: row({ attempts: [{ rung: 1, effort: 'medium', outcome: 'passed' }] }), holds: false },
  { name: 'an attempt rung that is a word', row: row({ attempts: [{ rung: 'low', effort: 'medium', outcome: 'passed', reason: '' }] }), holds: false },
  { name: 'agents as a string', row: row({ agents: '3' }), holds: false },
]

describe('the ledger row schema and parseLedgerLine give one verdict', () => {
  it.each(ROWS)('on $name: holds is $holds', ({ row: value, holds }) => {
    expect(violations(value, schema).length === 0, 'the schema').toBe(holds)
    expect(typeof parseLedgerLine(JSON.stringify(value)) !== 'string', 'the reader').toBe(holds)
  })

  it.each(HASH_FAULTS)('names $field when it refuses $name', ({ field, row: value }) => {
    expect(parseLedgerLine(JSON.stringify(value))).toContain(field)
  })

  it.each(SKETCH_FAULTS)('names sketch when it refuses $name', ({ row: value }) => {
    expect(parseLedgerLine(JSON.stringify(value))).toContain('sketch')
  })

  it('declares exactly the fields the reader knows, at ledger-row 1.2', () => {
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...LEDGER_FIELDS].sort())
    expect(schemaId(schema)).toBe('mikoshi-construct/contours/ledger-row/1.2')
  })
})

describe('the documents that explain the ledger row', () => {
  const docs = readFileSync(path.join(REPO_ROOT, 'docs/cli.md'), 'utf8')
  const section = docs.slice(docs.indexOf('### The run ledger')).split(/^###? /m)[1] ?? ''
  const skill = readFileSync(path.join(REPO_ROOT, '.claude/skills/implement/SKILL.md'), 'utf8')
  const stepFour = skill.slice(skill.indexOf('\n4. Record the run'), skill.indexOf('\n5. Relay the result'))

  it('has a table row for every field and points at the schema', () => {
    expect(section).toContain(SCHEMA_PATH)
    const rows = section.split('\n').filter(line => line.startsWith('| `'))
    for (const field of LEDGER_FIELDS)
      expect(rows.some(line => line.includes(`\`${field}\``)), `a table row for ${field}`).toBe(true)
  })

  it('is named field by field in step 4 of the implement skill', () => {
    for (const field of LEDGER_FIELDS)
      expect(stepFour, `step 4 names ${field}`).toContain(`\`${field}\``)
  })
})
