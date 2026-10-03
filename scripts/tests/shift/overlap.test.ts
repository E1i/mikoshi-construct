import type { ShiftTask } from '../../shift/task-file.js'
import { describe, expect, it } from 'vitest'
import { parseCard } from '../../ghosts/card.js'
import { openPrWarnings, relation, taskConflicts } from '../../shift/overlap.js'

const CARD = parseCard('#1 overlap [implement/ghosts/S/cheap/auto] · depends — · blocks —')

function task(file: string, id: string, touches: string[], branch = `feat/${id}`): ShiftTask {
  if (CARD.kind === 'refused')
    throw new Error(CARD.reason)
  return { file, number: file.slice(0, 2), id, card: CARD.card, branch, touches, body: 'x' }
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
