import type { DraftCard } from '../src/commands/intake/draft.js'
import type { RepositoryFacts } from '../src/commands/intake/facts.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runsOf } from '../src/card/covering-tests.js'
import { parseParkingFile } from '../src/card/parking.js'
import { runsFieldOf } from '../src/card/witness-fields.js'
import { checkDraft } from '../src/commands/intake/check.js'
import { sliceCards } from '../src/commands/intake/slice.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const INTAKE_SKILLS = ['.claude/skills/intake/SKILL.md', 'templates/ai/claude/_claude/skills/intake/SKILL.md']
const RECIPES = '.claude/skills/window-recipes/SKILL.md'
const COVERING = ['tests/a.test.ts', 'tests/b.test.ts']
const NO_SOURCES = { read: () => null, filesUnder: () => [] }
const WITNESS_FIELD = { id: 'W1', run: 'pnpm exec vitest run tests/a.test.ts', test: null, head: 'pass', base: 'fail', proves: 'the thing' } as const

const repository: RepositoryFacts = {
  exists: () => true,
  pathsNamed: () => [],
  commandResolves: () => true,
  testsCovering: () => COVERING,
}
const facts = { taken: new Set<number>(), parked: new Set<number>(), done: new Set<string>(), merged: new Set<string>(), repository }
const draft: DraftCard = { name: 'covered', kind: 'implement', milestone: 'netwatch', size: 'S', contour: 'cheap', decision: 'auto', touches: ['scripts/a.ts'], depends: [], blocks: [], creates: [], task: 'Change the code.', witnesses: ['`pnpm exec vitest run tests/a.test.ts` exits 0'], unclear: [] }

function writtenBody(card: DraftCard): string {
  const slice = sliceCards(checkDraft([card], [7], facts), [7], NO_SOURCES)
  if (slice.kind !== 'sliced')
    throw new Error(slice.reasons.join('; '))
  const parsed = parseParkingFile('7.md', slice.cards[0]!.text)
  if (parsed.kind !== 'parked')
    throw new Error(parsed.reason)
  return parsed.parked.task.body
}

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

describe('intake writes covering runs as a field', () => {
  it('a checked card carries its covering tests in a runs field and no Runs line', () => {
    const body = writtenBody(draft)
    expect(runsFieldOf(body)).toEqual(COVERING)
    expect(runsOf(body)).toEqual(COVERING)
    expect(body.split('\n').filter(line => line.startsWith('Runs:'))).toEqual([])
  })

  it('a card with witness fields carries one runs field beside them', () => {
    const body = writtenBody({ ...draft, witnessFields: [WITNESS_FIELD], runs: ['scripts/tests/bus/**'] })
    expect(runsFieldOf(body)).toEqual(['scripts/tests/bus/**', ...COVERING])
    expect(body.split('\n').filter(line => line.startsWith('runs: ['))).toHaveLength(1)
  })

  it('a card whose touches no test covers writes no runs field', () => {
    const uncovered = sliceCards(checkDraft([draft], [7], { ...facts, repository: { ...repository, testsCovering: () => [] } }), [7], NO_SOURCES)
    expect(uncovered.kind === 'sliced' ? runsFieldOf(uncovered.cards[0]!.text) : null).toEqual([])
  })

  it('the old Runs line still reads, so an admitted card stays valid', () => {
    expect(runsOf('Do it.\n\nRuns: tests/board/**\n\nWitnesses:\n- `test -f a` exits 0')).toEqual(['tests/board/**'])
  })

  it('the intake skill, its template and window-recipes show runs and witnesses as fields', () => {
    for (const skill of INTAKE_SKILLS) {
      const text = read(skill)
      expect(text).toContain('"witnesses": [ { "id": "W1", "run": "…", "test": null, "head": "pass", "base": "fail", "proves": "…" } ]')
      expect(text).toContain('"runs": ["tests/…/**"]')
      expect(text).toContain('Prose in `task` is explanation only')
      expect(text).not.toContain('"witnesses": ["…"]')
    }
    expect(read(RECIPES)).toContain('carries witnesses and runs as fields')
    expect(read(RECIPES)).toContain('Prose is explanation only')
  })
})
