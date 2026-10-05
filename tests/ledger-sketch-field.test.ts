import type { LedgerEntry } from '../src/commands/cost/ledger.js'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLedgerLine } from '../src/commands/cost/ledger.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKETCH_SHA = '0123456789abcdef0123456789abcdef01234567'

const BASE = {
  run: 'wf_abc',
  at: '2026-10-05T10:00:00.000Z',
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

function read(changes: Record<string, unknown>): LedgerEntry | string {
  return parseLedgerLine(JSON.stringify({ ...BASE, ...changes }))
}

function text(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

const SKILL_COPIES = ['.claude/skills/implement/SKILL.md', 'templates/ai/claude/_claude/skills/implement/SKILL.md']

function stepFour(skill: string): string {
  return skill.slice(skill.indexOf('\n4. Record the run'), skill.indexOf('\n5. Relay the result'))
}

function sketchBullet(skill: string): string {
  const bullets = stepFour(skill).split(/\n {3}- /)
  return bullets.find(bullet => bullet.startsWith('`sketch`')) ?? ''
}

describe('parseLedgerLine reads the sketch field of a ledger-row 1.2 line', () => {
  it('keeps the sha of the sketch the run started from', () => {
    const entry = read({ sketch: SKETCH_SHA }) as LedgerEntry
    expect(entry.sketch).toBe(SKETCH_SHA)
  })

  it('keeps null as null: a run that started from a clean tree', () => {
    const entry = read({ sketch: null }) as LedgerEntry
    expect(entry.sketch).toBeNull()
    expect(Object.hasOwn(entry, 'sketch')).toBe(true)
  })

  it('does not invent a value for a 1.1 line: the entry has no sketch key at all', () => {
    const entry = read({}) as LedgerEntry
    expect(Object.hasOwn(entry, 'sketch')).toBe(false)
    expect(entry.sketch).toBeUndefined()
  })

  it.each([
    ['three letters', 'abc'],
    ['a number', 7],
    ['39 hex', SKETCH_SHA.slice(1)],
    ['capitals', SKETCH_SHA.toUpperCase()],
    ['the empty string', ''],
    ['40 characters that are not hex', 'g'.repeat(40)],
    ['false', false],
  ])('refuses a sketch of %s and the refusal names sketch', (_name, value) => {
    const entry = read({ sketch: value })
    expect(typeof entry).toBe('string')
    expect(entry).toContain('sketch')
  })

  it('refuses a bad sketch without blaming a field that is fine', () => {
    expect(read({ sketch: 7 })).toBe('missing or invalid: sketch')
  })
})

describe('the sketch field is recorded where the other readers look', () => {
  it('names ledger-row/1.2 in the recorded surface, as the schema does', () => {
    const surface = JSON.parse(text('contract/surface.json')) as { contours: Record<string, string> }
    const schema = JSON.parse(text('contract/contours/ledger-row.schema.json')) as { $id: string }
    expect(surface.contours['ledger-row']).toBe('mikoshi-construct/contours/ledger-row/1.2')
    expect(schema.$id).toBe(surface.contours['ledger-row'])
  })

  it('has a step 4 of the implement skill that says where sketch comes from, in both copies, byte-identical', () => {
    const [factory, template] = SKILL_COPIES.map(text)
    expect(template).toBe(factory)
    for (const skill of [factory, template]) {
      const bullet = sketchBullet(skill)
      expect(bullet, 'a bullet that starts with `sketch`').not.toBe('')
      expect(bullet).toContain('handle')
      expect(bullet).toContain('`sha`')
      expect(bullet).toContain('`null`')
      expect(bullet).toMatch(/never (?:take|compute|work out|derive)/)
    }
  })

  it('names the ledger row sketch field in the --sketch paragraph of docs/cli.md', () => {
    const docs = text('docs/cli.md')
    const start = docs.indexOf('`--sketch yes` or `--sketch no`')
    const paragraph = docs.slice(start, docs.indexOf('`role <brief|scan|review>', start))
    expect(start).toBeGreaterThan(-1)
    expect(paragraph).toMatch(/ledger row[^.]*`sketch`|`sketch`[^.]*ledger row/)
    expect(paragraph).toContain('journal')
  })

  it('has row 10 of architecture/contours.md at ledger-row/1.2 with sketch among its optional fields', () => {
    const row = text('architecture/contours.md').split('\n').find(line => line.startsWith('| 10 |')) ?? ''
    const cells = row.split('|').map(cell => cell.trim())
    expect(cells[5]).toContain('ledger-row/1.2')
    expect(cells[5]).not.toContain('ledger-row/1.1')
    expect(cells[7]).toContain('`sketch`')
  })

  it('has decision 0051 on disk and in the decisions README, both about the sketch field of the ledger row', () => {
    const files = readdirSync(path.join(ROOT, 'architecture/decisions')).filter(name => name.startsWith('0051-'))
    expect(files).toHaveLength(1)
    const record = text(`architecture/decisions/${files[0]}`)
    expect(record.split('\n')[0]).toMatch(/^# 0051 — /)
    expect(record).toContain('sketch')
    expect(record).toContain('ledger')
    const row = text('architecture/decisions/README.md').split('\n').find(line => line.includes(`(${files[0]})`)) ?? ''
    expect(row).toContain('[0051]')
    expect(row).toContain('sketch')
  })
})
