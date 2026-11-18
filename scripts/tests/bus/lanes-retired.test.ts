import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { runMove } from '../../../src/commands/intake/move.js'
import { CARD_BODIES } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_MOVED, FACTORY_MODE, LANE_ASSIGNED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busIntakePorts } from '../../intake/intake.js'
import { busProjections } from '../../supervisor/composition.js'

const AT = new Date('2026-11-18T09:00:00.000Z')
const PARENT = 2201
const CHILD = 2202
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, repo: string, db: DatabaseSync }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'lanes-retired-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  const repo = path.join(root, 'repo')
  mkdirSync(parking)
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  writeFileSync(path.join(repo, 'src', 'b.ts'), '')
  return { parking, repo, db: openBus(path.join(root, 'bus.db')) }
}

function park(w: World, id: number, touches: string, depends = '—'): string {
  const file = path.join(w.parking, `${id}.md`)
  writeFileSync(file, `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${depends} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
  return file
}

function admit(w: World, file: string): string {
  const ports = busIntakePorts(w.db, 'by-hand')
  return runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => AT).status
}

function payloads(w: World, type: string): Record<string, unknown>[] {
  return (w.db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

function parallel(w: World): void {
  appendEvent(w.db, { ts: AT.toISOString(), type: FACTORY_MODE, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${FACTORY_MODE}:parallel`, payload: { mode: 'parallel' }, legacy: false })
}

describe('lanes leave intake and the card body', () => {
  it('intake admits a card with no lane', () => {
    const w = world()
    try {
      parallel(w)
      expect(admit(w, park(w, PARENT, 'src/a.ts'))).toBe('admitted')
      expect(admit(w, park(w, CHILD, 'src/b.ts', `#${PARENT}`))).toBe('admitted')
      const ports = busIntakePorts(w.db, 'by-hand')
      const moved = runMove({ move: `#${PARENT}`, to: 'lane-3', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events: ports.cardEvents, admissions: ports.cardAdmissions }, () => AT)
      expect(moved).toMatchObject({ status: 'moved', event: CARD_MOVED })
      expect(payloads(w, CARD_ADMITTED)).toHaveLength(3)
      expect([...payloads(w, CARD_ADMITTED), ...payloads(w, CARD_MOVED)].filter(payload => 'lane' in payload)).toEqual([])
      expect(payloads(w, LANE_ASSIGNED)).toEqual([])
    }
    finally {
      w.db.close()
    }
  })

  it('an admitted card body carries no lane', () => {
    const w = world()
    try {
      expect(admit(w, park(w, PARENT, 'src/a.ts'))).toBe('admitted')
      reduce(w.db, 'pending', busProjections())
      expect(w.db.prepare(`SELECT card_id, lane FROM ${CARD_BODIES}`).all()).toEqual([{ card_id: PARENT, lane: null }])
      expect(payloads(w, CARD_ADMITTED).map(payload => 'lane' in payload)).toEqual([false])
    }
    finally {
      w.db.close()
    }
  })
})
