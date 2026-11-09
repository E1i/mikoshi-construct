import type { IntakeResult } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { groupsOf } from '../src/card/risk.js'
import { runIntake } from '../src/commands/intake/index.js'
import { HELD_WHOLE_PREFIX } from '../src/commands/intake/slice.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const OVER_HALF_A_SESSION = 'x'.repeat(300_000)

interface DraftCard {
  touches: string[]
  whole?: string
  size?: string
}

function intake(card: DraftCard, sources: Record<string, string>): IntakeResult {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-whole-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const touch of card.touches) {
    mkdirSync(path.dirname(path.join(repo, touch)), { recursive: true })
    writeFileSync(path.join(repo, touch), sources[touch] ?? '')
  }
  const draft = { cards: [{ name: 'vedeti-card', kind: 'implement', milestone: 'black-ice', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', task: 'Move the dependency and its lock.', witnesses: ['`pnpm test` exits 0'], ...card }] }
  const draftFile = path.join(root, 'draft.json')
  writeFileSync(draftFile, JSON.stringify(draft))
  return runIntake({ draft: draftFile, taken: '-', parking: path.join(root, 'parking'), dir: repo, dryRun: true, autoConfirm: false, readStdin: () => '1' })
}

function onlyCard(result: IntakeResult) {
  if (result.status === 'refused')
    throw new Error(`refused: ${result.detail.join('; ')}`)
  expect(result.cards).toHaveLength(1)
  return result.cards[0]!
}

function sliceLines(lines: readonly string[]): string[] {
  return lines.filter(line => line.startsWith('slice: '))
}

describe('a card the draft keeps whole is held whole', () => {
  const reason = 'the owner keeps the migration one change'

  it('a card with whole is held without slices and marked whole', () => {
    const card = onlyCard(intake({ touches: ['src/a.ts', 'src/b.ts'], whole: reason }, { 'src/a.ts': OVER_HALF_A_SESSION, 'src/b.ts': OVER_HALF_A_SESSION }))
    expect(card.slices).toEqual([])
    expect(sliceLines([...card.seam, ...card.risk])).toEqual([])
    expect(card.seam.filter(line => line.startsWith(HELD_WHOLE_PREFIX))).toEqual([`${HELD_WHOLE_PREFIX}whole: keeps this card one card, so the 2 slices the seams proposed are not cut; --confirm parks it whole`])
    expect(card.text).toContain(`whole: ${reason}`)
    expect(sliceLines(card.text.split('\n'))).toEqual([])
  })

  it('a card with whole proposes no risk slices, so the risk seam does not hold it', () => {
    const card = onlyCard(intake({ touches: ['src/commands/detach/index.ts', 'src/ui/lore.ts', 'docs/cli.md'], whole: reason }, {}))
    expect(card.slices).toEqual([])
    expect(card.risk.filter(line => line.startsWith('seam: ') || line.startsWith('slice: '))).toEqual([])
    expect(card.seam.some(line => line.startsWith(HELD_WHOLE_PREFIX))).toBe(true)
  })

  it('the same card without whole is still sliced by volume', () => {
    const card = onlyCard(intake({ touches: ['src/a.ts', 'src/b.ts'] }, { 'src/a.ts': OVER_HALF_A_SESSION, 'src/b.ts': OVER_HALF_A_SESSION }))
    expect(card.slices.map(slice => slice.touches)).toEqual([['src/a.ts'], ['src/b.ts']])
    expect(card.seam.some(line => line.startsWith(HELD_WHOLE_PREFIX))).toBe(false)
  })
})

describe('a lock file never leaves its manifest', () => {
  it('a card with package.json and pnpm-lock.yaml gets no slice of the lock file alone', () => {
    const card = onlyCard(intake({ touches: ['src/a.ts', 'package.json', 'pnpm-lock.yaml'] }, { 'src/a.ts': OVER_HALF_A_SESSION, 'package.json': '{}', 'pnpm-lock.yaml': OVER_HALF_A_SESSION }))
    expect(card.slices.map(slice => slice.touches)).toEqual([['src/a.ts'], ['package.json', 'pnpm-lock.yaml']])
  })

  const groups: readonly (readonly [string, readonly string[], readonly number[]])[] = [
    ['a root lock joins the root manifest', ['src/a.ts', 'package.json', 'pnpm-lock.yaml'], [0, 1, 1]],
    ['a root lock joins a workspace manifest', ['packages/x/package.json', 'src/a.ts', 'pnpm-lock.yaml'], [0, 1, 0]],
    ['a root lock joins pnpm-workspace.yaml', ['pnpm-workspace.yaml', 'pnpm-lock.yaml'], [0, 0]],
    ['a package lock does not join a sibling package manifest', ['packages/x/package-lock.json', 'packages/y/package.json', 'src/a.ts'], [1, 1, 2]],
    ['a lock with no manifest rides with the first other touch', ['src/a.ts', 'src/b.ts', 'yarn.lock'], [0, 1, 0]],
    ['a lock alone stays alone', ['pnpm-lock.yaml'], [0]],
  ]

  for (const [name, touches, expected] of groups) {
    it(name, () => {
      expect(groupsOf(touches)).toEqual(expected)
    })
  }
})
