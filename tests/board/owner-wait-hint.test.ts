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
const OLD_FORMS = ['decisions:add', 'owner:say', 'merge', HEAD, HEAD.slice(0, 8)]
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

function expectOnlyTheAnswer(command: string, target: string): void {
  expect(command).toBe(answers(target))
  for (const old of OLD_FORMS)
    expect(command).not.toContain(old)
}

describe('the owner wait hint is owner:answer', () => {
  it('an open owner wait of every kind shows owner:answer and nothing else', () => {
    const waits = [
      ownerWait('Q1', 'decision', 1937, null),
      ownerWait('Q2', 'decision', null, null),
      ownerWait('Q3', 'merge', 1937, 669),
      ownerWait('Q4', 'merge', null, 669),
      ownerWait('Q5', 'decision', 1937, 669),
      ownerWait('Q6', 'decision', null, 670),
      ownerWait('Q7', 'command', null, null, allowLiveCommand('merge')),
    ]
    for (const wait of waits) {
      expect(waitHint(wait).who).toBe('owner')
      expectOnlyTheAnswer(waitHint(wait).command, wait.id)
    }
    expectOnlyTheAnswer(waitHint(ownerWait('W12', 'decision', 1807, null)).command, '#1807')
    const [line] = waitsLines({ waits } as Parameters<typeof waitsLines>[0], PLAIN_LORE)
    for (const wait of waits)
      expect(line).toContain(`${wait.text} · owner runs: ${answers(wait.id)}`)
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
      const hints = openOwnerWaits(db).map(wait => [wait.id, waitHint(wait)])
      expect(hints).toEqual([decision, merge, roundLimit, live].map(id => [id, { who: 'owner', command: answers(id) }]))
      for (const [, hint] of hints)
        expect(JSON.stringify(hint)).not.toContain('decisions:add')
    }
    finally {
      db.close()
    }
  })
})
