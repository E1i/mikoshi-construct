import type { BusCardStates } from '../src/card/closed.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runIntake } from '../src/commands/intake/index.js'

const TASK = 'The intake should know a card the bus holds when it checks a depends.'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function unclearFieldsOfDraft(cards: BusCardStates, depends: string[]): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-depends-bus-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  const draft = path.join(root, 'draft.json')
  const card = { name: 'depends-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: TASK, witnesses: ['`pnpm run quality` is green'], depends }
  writeFileSync(draft, JSON.stringify({ cards: [card] }))
  const result = runIntake({ draft, parking, dir: root, dryRun: true, autoConfirm: true, readStdin: () => '1', taken: '-', cardStates: () => cards })
  if (result.status !== 'dryRun')
    throw new Error(`expected a dry run, got ${result.status}`)
  return result.cards[0]!.unclear.map(entry => entry.field)
}

describe('intake --draft knows the cards the bus holds, as --admit does', () => {
  it('a draft card depending on a card the bus holds is not marked unclear', () => {
    for (const state of ['running', 'review'])
      expect(unclearFieldsOfDraft(new Map([['77', state]]), ['#77'])).not.toContain('depends')
  })

  it('a draft card depending on an unknown card stays unclear', () => {
    expect(unclearFieldsOfDraft(new Map([['77', 'running']]), ['#88'])).toContain('depends')
  })
})
