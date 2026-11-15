import type { OwnerWait } from '../../src/commands/board/bus.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openOwnerWaits } from '../../scripts/core/bus-readings.js'
import { openBus, openBusWait } from '../../scripts/core/db.js'
import { reduce } from '../../scripts/core/reducer.js'
import { allowLiveCommand } from '../../scripts/policy/live-decision.js'
import { busProjections } from '../../scripts/supervisor/composition.js'
import { waitHint, waitsLines } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'

const SINCE = '2026-11-14T22:00:00.000Z'
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OLD_FORMS = ['decisions:add', 'owner:say', 'pnpm merge', 'gh pr merge', HEAD, HEAD.slice(0, 8)]
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function ownerWait(id: string, need: OwnerWait['need'], card: number | null, pr: number | null, command: string | null = null): OwnerWait {
  return { id, need, text: `wait ${id}`, command, card, pr, since: SINCE, lifter: 'owner', decision: null }
}

function answers(id: string): string {
  return `pnpm owner:answer ${id} "…"`
}

function merges(pr: number): string {
  return `merge PR #${pr} (owner)`
}

function expectOnly(command: string, expected: string): void {
  expect(command).toBe(expected)
  for (const old of OLD_FORMS)
    expect(command).not.toContain(old)
}

describe('the owner wait hint is owner:answer', () => {
  it('an open owner wait shows owner:answer, and a merge wait the neutral owner merge line', () => {
    const answered = [
      ownerWait('Q1', 'decision', 1937, null),
      ownerWait('Q2', 'decision', null, null),
      ownerWait('Q5', 'decision', 1937, 669),
      ownerWait('Q6', 'decision', null, 670),
      ownerWait('Q7', 'command', null, null, allowLiveCommand('merge')),
      ownerWait('Q8', 'command', 1937, null, allowLiveCommand('review')),
    ]
    const merged = [ownerWait('Q3', 'merge', 1937, 669), ownerWait('Q4', 'merge', null, 671)]
    for (const wait of answered) {
      expect(waitHint(wait).who).toBe('owner')
      expectOnly(waitHint(wait).command, answers(wait.id))
    }
    for (const wait of merged) {
      expect(waitHint(wait).who).toBe('owner')
      expectOnly(waitHint(wait).command, merges(wait.pr!))
      expect(waitHint(wait).command).not.toContain('owner:answer')
    }
    expectOnly(waitHint(ownerWait('W12', 'decision', 1807, null)).command, answers('#1807'))
    const waits = [...answered, ...merged]
    const [line] = waitsLines({ waits } as Parameters<typeof waitsLines>[0], PLAIN_LORE)
    for (const wait of answered)
      expect(line).toContain(`${wait.text} · owner runs: ${answers(wait.id)}`)
    for (const wait of merged)
      expect(line).toContain(`${wait.text} · owner runs: ${merges(wait.pr!)}`)
    expect(line).not.toContain('decisions:add')
  })

  it('the command a wait carries in the bus is owner:answer', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'owner-wait-hint-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    try {
      const decision = openBusWait(db, SINCE, 'policy', { need: 'decision', text: 'which path?', card: 1937, pr: 671 })
      const merge = openBusWait(db, SINCE, 'policy', { need: 'merge', text: 'changes security invariants', card: 1937, pr: 669 })
      const roundLimit = openBusWait(db, SINCE, 'policy', { need: 'decision', text: 'past the round limit', card: 1938, pr: 670 })
      const live = openBusWait(db, SINCE, 'policy', { need: 'command', text: 'the merge queue merges unswitched', command: allowLiveCommand('merge') })
      reduce(db, 'pending', busProjections())
      const recorded = openOwnerWaits(db).map(wait => [wait.id, wait.command])
      expect(recorded).toEqual([[decision, answers(decision)], [merge, merges(669)], [roundLimit, answers(roundLimit)], [live, answers(live)]])
      for (const [, command] of recorded) {
        for (const old of OLD_FORMS)
          expect(command).not.toContain(old)
      }
      expect(openOwnerWaits(db).map(wait => waitHint(wait).command)).toEqual(recorded.map(([, command]) => command))
    }
    finally {
      db.close()
    }
  })
})
