import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AMEND_SOURCE, runAdmit } from '../../../src/commands/intake/admit.js'
import { runAmend } from '../../../src/commands/intake/amend.js'
import { bodySha } from '../../../src/commands/intake/confirm.js'
import { runMove } from '../../../src/commands/intake/move.js'
import { cardBodyText } from '../../core/card-bodies.js'
import { openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_MOVED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busIntakePorts } from '../../intake/intake.js'

const AT = new Date('2026-10-13T09:00:00.000Z')
const CARD = 1462
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, repo: string, db: ReturnType<typeof openBus> }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'card-body-events-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  const repo = path.join(root, 'repo')
  mkdirSync(parking)
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  return { parking, repo, db: openBus(path.join(root, 'bus.db')) }
}

function cardText(header: { who: string, priority: string }): string {
  return `card: #${CARD} card-${CARD} [implement/black-ice/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: src/a.ts\ncontinue: stop\nwho: ${header.who}\npriority: ${header.priority}\n\nDo the thing.\n`
}

function park(w: World, text: string): string {
  const file = path.join(w.parking, `${CARD}.md`)
  writeFileSync(file, text)
  return file
}

const MINUTE_MS = 60_000
let admits = 0

function admit(w: World, file: string) {
  const ports = busIntakePorts(w.db, 'by-hand', () => 1)
  const at = new Date(AT.getTime() + MINUTE_MS * ++admits)
  return runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => at)
}

function payloadsOf(w: World, type: string): Record<string, unknown>[] {
  const rows = w.db.prepare('SELECT payload FROM events WHERE type = ? AND card_id = ? ORDER BY id').all(type, CARD) as { payload: string }[]
  return rows.map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

describe('the card body lives only in card.* events', () => {
  it('a move right after an amend carries the amended body', () => {
    const w = world()
    try {
      const ports = busIntakePorts(w.db, 'by-hand', () => 1)
      const file = park(w, cardText({ who: 'window', priority: 'p2' }))
      expect(admit(w, file).status).toBe('admitted')
      reduce(w.db)
      const amend = { dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }
      expect(runAmend({ ...amend, card: `#${CARD}`, flags: { note: 'The amended line.' } }, () => AT).status).toBe('admitted')
      reduce(w.db)
      const amended = payloadsOf(w, CARD_ADMITTED).at(-1)!
      expect(readFileSync(file, 'utf8')).not.toContain('The amended line.')
      const moved = runMove({ move: `#${CARD}`, to: 'lane-3', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events: ports.cardEvents, admissions: ports.cardAdmissions }, () => AT)
      expect(moved.status).toBe('moved')
      expect(payloadsOf(w, CARD_MOVED)).toMatchObject([{ bodySha: amended.bodySha }])
      expect(amended.bodySha).toBe(bodySha(String(amended.text)))
      expect(String(payloadsOf(w, CARD_ADMITTED).at(-1)!.text)).toContain('The amended line.')
      reduce(w.db)
      expect(cardBodyText(w.db, CARD)).toContain('The amended line.')
    }
    finally {
      w.db.close()
    }
  })

  it('a changed header is not read as already admitted', () => {
    const changes = [{ who: 'window', priority: 'p0' }, { who: 'shift', priority: 'p0' }]
    const w = world()
    try {
      const file = park(w, cardText({ who: 'window', priority: 'p2' }))
      expect(admit(w, file).status).toBe('admitted')
      expect(admit(w, file).status).toBe('alreadyAdmitted')
      for (const header of changes) {
        park(w, cardText(header))
        expect(admit(w, file)).toMatchObject({ status: 'admitted', source: AMEND_SOURCE })
        expect(payloadsOf(w, CARD_ADMITTED).at(-1)!.text).toContain(`who: ${header.who}\npriority: ${header.priority}\n`)
        expect(admit(w, file).status).toBe('alreadyAdmitted')
      }
    }
    finally {
      w.db.close()
    }
  })
})
