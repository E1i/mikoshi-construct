import type { IntakeResult } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { groupsOf } from '../src/card/risk.js'
import { printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const OVER_HALF_A_SESSION = 'x'.repeat(300_000)

interface DraftCard {
  touches: string[]
  name?: string
  task?: string
  whole?: string
}

function intakeAll(draftCards: readonly DraftCard[], sources: Record<string, string>, dryRun = true): IntakeResult {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-whole-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const touch of draftCards.flatMap(card => card.touches)) {
    mkdirSync(path.dirname(path.join(repo, touch)), { recursive: true })
    writeFileSync(path.join(repo, touch), sources[touch] ?? '')
  }
  const draft = { cards: draftCards.map(card => ({ name: 'vedeti-card', kind: 'implement', milestone: 'black-ice', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', task: 'Move the dependency and its lock.', witnesses: ['`pnpm test` exits 0'], ...card })) }
  const draftFile = path.join(root, 'draft.json')
  writeFileSync(draftFile, JSON.stringify(draft))
  return runIntake({ draft: draftFile, taken: '-', parking: path.join(root, 'parking'), dir: repo, dryRun, autoConfirm: false, readStdin: () => '1' })
}

function intake(card: DraftCard, sources: Record<string, string>): IntakeResult {
  return intakeAll([card], sources)
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

function printed(result: IntakeResult): string[] {
  const lines: string[] = []
  printIntake(createUi(resolveTheme({ plain: true }), text => lines.push(...text.split('\n'))), result)
  return lines.map(line => line.trim())
}

describe('a card the draft keeps whole is held whole', () => {
  const reason = 'the owner keeps the migration one change'
  const bigSources = { 'src/a.ts': OVER_HALF_A_SESSION, 'src/b.ts': OVER_HALF_A_SESSION }
  const keptWhole: DraftCard = { name: 'kept-whole', touches: ['src/a.ts', 'src/b.ts'], whole: reason }
  const riskSliced: DraftCard = { name: 'risk-sliced', task: 'Detach says what it restored.', touches: ['src/commands/detach/index.ts', 'src/ui/lore.ts', 'docs/cli.md'] }

  it('a card with whole is not under Held and prints only whole with its reason, with no seam or slice', () => {
    const result = intakeAll([keptWhole, riskSliced], bigSources, false)
    expect(result.status).toBe('awaiting')
    const [whole, held] = result.status === 'awaiting' ? result.cards : []
    const lines = printed(result)
    expect(lines.filter(line => line.startsWith('Held: '))).toEqual([`Held: ${held!.line}`])
    const at = lines.indexOf(`Whole: ${whole!.line} (whole: ${reason})`)
    expect(at).toBeGreaterThanOrEqual(0)
    const own = lines.slice(at + 1, lines.indexOf(`Held: ${held!.line}`))
    expect(own.filter(line => line.startsWith('seam: ') || line.startsWith('slice: ') || line.startsWith('risk: '))).toEqual([])
    expect(lines.some(line => line.startsWith('slice: '))).toBe(true)
  })

  it('a card with whole carries no slices and its text no slice lines', () => {
    const card = onlyCard(intake(keptWhole, bigSources))
    expect(card.slices).toEqual([])
    expect(card.whole).toBe(reason)
    expect(card.text).toContain(`whole: ${reason}`)
    expect(sliceLines(card.text.split('\n'))).toEqual([])
  })

  it('a card with whole proposes no risk slices, so the risk seam does not hold it', () => {
    const card = onlyCard(intake({ ...riskSliced, whole: reason }, {}))
    expect(card.slices).toEqual([])
    expect(card.risk.filter(line => line.startsWith('seam: ') || line.startsWith('slice: '))).toEqual([])
  })

  it('the same card without whole is still sliced by volume', () => {
    const card = onlyCard(intake({ touches: ['src/a.ts', 'src/b.ts'] }, bigSources))
    expect(card.slices.map(slice => slice.touches)).toEqual([['src/a.ts'], ['src/b.ts']])
    expect(card.whole).toBeUndefined()
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
