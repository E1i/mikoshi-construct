import type { IntakeResult } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCard } from '../src/card/grammar.js'
import { riskOf } from '../src/card/risk.js'
import { CONTOUR_NOT_FROM_RISK, LADDER_GRAMMAR } from '../src/commands/intake/check.js'
import { runIntake } from '../src/commands/intake/index.js'

const TOUCH_AT_LEVEL: Record<string, string> = {
  R1: 'scripts/ladder/launch.ts',
  R2: 'scripts/ladder/verdict.ts',
  R3: 'scripts/composition/check.ts',
  R4: 'docs/cli.md',
}

const OWNER_WORD_AND_REASON = 'ladder: owner s337 — two cheap falls, #1201 a red lint and #1202 a witness green on the base'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function intakeOf(card: Record<string, unknown>): IntakeResult {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-contour-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const touch of card.touches as string[]) {
    mkdirSync(path.dirname(path.join(repo, touch)), { recursive: true })
    writeFileSync(path.join(repo, touch), '')
  }
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards: [{ name: 'a-card', kind: 'implement', milestone: 'runner', size: 'M', decision: 'owner', who: 'shift', witnesses: ['`pnpm test` passes'], ...card }] }))
  return runIntake({ draft, taken: '-', parking: path.join(root, 'parking'), dir: repo, dryRun: true, autoConfirm: true, readStdin: () => '' })
}

function onlyCard(result: IntakeResult) {
  if (result.status !== 'dryRun')
    throw new Error(`expected a dry run, got ${result.status}`)
  const [card] = result.cards
  const parsed = parseCard(card!.line)
  if (parsed.kind !== 'card')
    throw new Error(parsed.reason)
  return { card: card!, contour: parsed.card.contour }
}

describe('intake contour', () => {
  it('intake sets cheap whatever the risk', () => {
    for (const [level, touch] of Object.entries(TOUCH_AT_LEVEL)) {
      expect(riskOf(touch).level).toBe(level)
      const { card, contour } = onlyCard(intakeOf({ touches: [touch], task: 'Change the thing.' }))
      expect(contour).toBe('cheap')
      expect(card.unclear.map(entry => entry.field)).not.toContain('contour')
      expect(card.corrections.map(correction => correction.field)).not.toContain('contour')
    }
  })

  it('intake refuses ladder without the owner word and a reason', () => {
    const touches = [TOUCH_AT_LEVEL.R1!]
    for (const task of [
      'Change the thing.',
      'Change the thing.\nladder: owner s337',
      'Change the thing.\nladder: — two cheap falls, #1201 and #1202',
      'Change the thing.\nladder: two cheap falls, #1201 and #1202',
    ]) {
      const { card, contour } = onlyCard(intakeOf({ touches, contour: 'ladder', task }))
      expect(contour).toBe('cheap')
      expect(card.corrections).toContainEqual({ field: 'contour', was: 'ladder', now: 'cheap', reason: expect.stringContaining(LADDER_GRAMMAR) })
      expect(card.text).toContain(CONTOUR_NOT_FROM_RISK)
    }
    const sent = onlyCard(intakeOf({ touches, contour: 'ladder', task: `Change the thing.\n${OWNER_WORD_AND_REASON}` }))
    expect(sent.contour).toBe('ladder')
    expect(sent.card.corrections.map(correction => correction.field)).not.toContain('contour')
    expect(sent.card.text).toContain(OWNER_WORD_AND_REASON)
  })
})
