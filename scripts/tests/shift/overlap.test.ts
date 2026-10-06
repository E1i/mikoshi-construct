import type { ShiftTask } from '../../../src/card/task-file.js'
import { describe, expect, it } from 'vitest'
import { parseCard } from '../../../src/card/grammar.js'
import { openPrWarnings, relation, taskConflicts } from '../../shift/overlap.js'

const CARD = parseCard('#1 overlap [implement/ghosts/S/cheap/auto] · depends — · blocks —')

function task(file: string, id: string, touches: string[], branch = `feat/${id}`): ShiftTask {
  if (CARD.kind === 'refused')
    throw new Error(CARD.reason)
  return { file, number: file.slice(0, 2), id, card: CARD.card, branch, touches, body: 'x', continue: 'stop' }
}

describe('relation', () => {
  it.each([
    ['scripts/night/**', 'scripts/night/run.ts', '⊃'],
    ['scripts/night/run.ts', 'scripts/night/**', '⊂'],
    ['scripts/night/**', 'scripts/night', '⊃'],
    ['scripts/night/**', 'scripts/night/a/**', '⊃'],
    ['docs/a.md', 'docs/a.md', '='],
    ['scripts/night/**', 'scripts/nightly/run.ts', null],
    ['scripts/night', 'scripts/night/run.ts', null],
    ['docs/a.md', 'docs/b.md', null],
  ])('%s against %s is %s', (a, b, sign) => {
    expect(relation(a, b)).toBe(sign)
  })
})

describe('taskConflicts', () => {
  it('lists every overlapping pair, a repeated task id and a repeated branch', () => {
    expect(taskConflicts([
      task('01.md', 'a', ['scripts/a/**']),
      task('02.md', 'a', ['docs/x.md'], 'feat/same'),
      task('03.md', 'c', ['scripts/a/b.ts', 'docs/x.md'], 'feat/same'),
    ])).toEqual([
      '01.md × 02.md: task a twice',
      '01.md × 03.md: scripts/a/** ⊃ scripts/a/b.ts',
      '02.md × 03.md: branch feat/same twice',
      '02.md × 03.md: docs/x.md = docs/x.md',
    ])
  })

  it('a mask against a mask is no conflict under tests, scripts/tests and .changeset', () => {
    expect(taskConflicts([
      task('01.md', 'a', ['tests/**', 'scripts/tests/**', '.changeset/**']),
      task('02.md', 'b', ['tests/shift/**', 'scripts/tests/shift/**', '.changeset/**']),
    ])).toEqual([])
  })

  it('a named file against tests/** is no conflict, nor under scripts/tests/** or .changeset/**', () => {
    expect(taskConflicts([
      task('01.md', 'a', ['tests/**', 'scripts/tests/shift/**', '.changeset/**']),
      task('02.md', 'b', ['tests/shift.test.ts', 'scripts/tests/shift/overlap.test.ts', '.changeset/intake-subparking-sees-root-numbers.md']),
    ])).toEqual([])
    expect(taskConflicts([
      task('01.md', 'a', ['.changeset/intake-subparking-sees-root-numbers.md']),
      task('02.md', 'b', ['.changeset/**']),
    ])).toEqual([])
  })

  it('two identical named files conflict under the additive roots', () => {
    expect(taskConflicts([
      task('01.md', 'a', ['tests/shift.test.ts', 'scripts/tests/shift/overlap.test.ts', '.changeset/x.md']),
      task('02.md', 'b', ['tests/shift.test.ts', 'scripts/tests/shift/overlap.test.ts', '.changeset/x.md']),
    ])).toEqual([
      '01.md × 02.md: tests/shift.test.ts = tests/shift.test.ts',
      '01.md × 02.md: scripts/tests/shift/overlap.test.ts = scripts/tests/shift/overlap.test.ts',
      '01.md × 02.md: .changeset/x.md = .changeset/x.md',
    ])
  })

  it('a named file under an additive root still conflicts with a mask outside them', () => {
    expect(taskConflicts([
      task('01.md', 'a', ['scripts/**']),
      task('02.md', 'b', ['scripts/tests/shift/overlap.test.ts']),
    ])).toEqual(['01.md × 02.md: scripts/** ⊃ scripts/tests/shift/overlap.test.ts'])
  })

  it('keeps a mask against a mask a conflict outside tests and .changeset', () => {
    expect(taskConflicts([
      task('01.md', 'a', ['src/**', 'scripts/a/**', 'tests/**']),
      task('02.md', 'b', ['src/card/**', 'scripts/**', 'scripts/tests/**']),
    ])).toEqual([
      '01.md × 02.md: src/** ⊃ src/card/**',
      '01.md × 02.md: scripts/a/** ⊂ scripts/**',
    ])
  })

  it('is empty for disjoint tasks', () => {
    expect(taskConflicts([task('01.md', 'a', ['scripts/a/**']), task('02.md', 'b', ['scripts/ab/**'])])).toEqual([])
  })
})

describe('openPrWarnings', () => {
  it('names each touches entry that meets a file of an open pull request', () => {
    expect(openPrWarnings(
      [task('02.md', 'b', ['scripts/board/**', 'docs/b.md'])],
      [{ number: 436, headRefName: 'x', files: ['scripts/board/run.ts', 'scripts/board/gh.ts'] }, { number: 437, headRefName: 'y', files: ['docs/c.md'] }],
    )).toEqual(['02.md × PR #436: scripts/board/**'])
  })
})
