import type { CardEvent, IntakeOptions, IntakeResult } from '../../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_ADMITTED } from '../../scripts/core/events.js'
import { runIntake } from '../../src/commands/intake/index.js'

const TAKEN_THROUGH = '12'
const PARENT = 13
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { repo: string, parking: string, draft: string, bus: CardEvent[] }

function world(touches: readonly string[], fields: Record<string, unknown> = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), 'slice-parent-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const entry of touches) {
    mkdirSync(path.dirname(path.join(repo, entry)), { recursive: true })
    writeFileSync(path.join(repo, entry), '')
  }
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards: [{ name: 'cut-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', touches, task: 'Cut the card.', witnesses: ['`pnpm run quality` is green'], ...fields }] }))
  return { repo, parking: path.join(root, 'parking'), draft, bus: [] }
}

function intake(w: World, options: Partial<IntakeOptions> = {}): IntakeResult {
  return runIntake({ draft: w.draft, taken: '-', parking: w.parking, dir: w.repo, dryRun: false, autoConfirm: false, readStdin: () => TAKEN_THROUGH, events: event => w.bus.push(event), ...options })
}

function parentsAdmitted(bus: readonly CardEvent[]): [number, unknown][] {
  return bus.filter(event => event.type === CARD_ADMITTED).map(event => [event.cardId, event.payload.parent ?? null])
}

describe('the Shredder writes the parent on each slice it cuts', () => {
  it('cutting a card into two slices writes the parent number and k of n on both slices\' card.admitted', () => {
    const w = world(['scripts/core/queue.ts', 'scripts/core/inbox.ts'])
    writeFileSync(path.join(w.repo, 'scripts/core/queue.ts'), 'import { inboxOf } from \'./inbox.js\'\n')
    const held = intake(w)
    expect(held.status).toBe('awaiting')
    const confirmed = intake(w, { confirm: held.status === 'awaiting' ? held.token : '' })
    expect(confirmed.status).toBe('written')
    expect(parentsAdmitted(w.bus)).toEqual([
      [13, { card: PARENT, part: 1, of: 2 }],
      [14, { card: PARENT, part: 2, of: 2 }],
    ])
  })

  it('a card admitted whole carries no parent', () => {
    const w = world(['src/a.ts'])
    expect(intake(w, { autoConfirm: true }).status).toBe('written')
    expect(parentsAdmitted(w.bus)).toEqual([[13, null]])
  })
})
