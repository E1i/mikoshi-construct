import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { CARD_ADMITTED } from '../../../src/commands/intake/index.js'
import { cardBodyText, WINDOW_LANE } from '../../bus/card-bodies.js'
import { appendEvent, BUS_DB_VARIABLE, openBus } from '../../bus/db.js'
import { busCardAdmissions, busIntakePorts, intakeAdmissions } from '../../bus/intake.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { replayDifferences } from '../../bus/report.js'

const AFTER_THE_CUTOFF = new Date('2026-10-13T09:00:00.000Z')
const CARD = '#90 body-card [implement/netwatch/S/cheap/auto] · depends — · blocks —'
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, journal: string, repo: string, bus: string, file: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'card-bodies-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(parking, 'lane-7'), { recursive: true })
  const file = path.join(parking, 'lane-7', '90.md')
  writeFileSync(file, `card: ${CARD}\nbranch: feat/body-card\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  return { parking, journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo, bus, file }
}

function admit(w: World): void {
  const db = openBus(w.bus)
  try {
    const ports = busIntakePorts(db, 's1')
    runAdmit({ file: w.file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => AFTER_THE_CUTOFF)
  }
  finally {
    db.close()
  }
}

function withBus<T>(w: World, read: (db: DatabaseSync) => T): T {
  const db = openBus(w.bus)
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function admissionIds(db: DatabaseSync): number[] {
  return (db.prepare(`SELECT id FROM events WHERE type = '${CARD_ADMITTED}' ORDER BY id`).all() as { id: number }[]).map(row => row.id)
}

function bodyRow(db: DatabaseSync): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM card_bodies WHERE card_id = 90').get() as Record<string, unknown> | undefined
}

function appendAdmission(db: DatabaseSync, key: string, payload: Record<string, unknown>): void {
  appendEvent(db, { ts: '2026-10-13T10:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:s1', cardId: 90, pr: null, head: null, dedupeKey: key, payload, legacy: false })
}

describe('the reducer folds every admitted text into card_bodies', () => {
  it('after replay card_bodies holds the latest admission', () => {
    const w = world()
    admit(w)
    const amended = readFileSync(w.file, 'utf8').replace('Do the thing.', 'Do the other thing.')
    writeFileSync(w.file, amended)
    admit(w)
    withBus(w, (db) => {
      reduce(db)
      expect(bodyRow(db)).toEqual({
        card_id: 90,
        admission_event_id: admissionIds(db)[1],
        text: amended,
        text_sha: sha256(amended),
        lane: WINDOW_LANE,
        who: 'shift',
        priority: null,
        branch: 'feat/body-card',
        touches: '["src/a.ts"]',
        creates: '[]',
        card_line: CARD,
        contour: 'cheap',
        decision: 'auto',
        depends: '[]',
      })
      expect(replayDifferences(db).differences).toEqual([])
      const before = projectionDump(db)
      reduce(db)
      expect(projectionDump(db)).toBe(before)
    })
  })

  it('an admission whose textSha is not the sha of its text writes no body', () => {
    const w = world()
    withBus(w, (db) => {
      appendAdmission(db, 'forged', { card: CARD, text: 'card: x\n', textSha: sha256('card: y\n') })
      reduce(db)
      expect(bodyRow(db)).toBeUndefined()
    })
  })

  it('a text the grammar refuses is kept with its parsed columns empty, and the card state still folds', () => {
    const w = world()
    withBus(w, (db) => {
      appendAdmission(db, 'refused', { card: CARD, lane: 'lane-7', text: 'not a card\n', textSha: sha256('not a card\n') })
      reduce(db)
      expect(bodyRow(db)).toMatchObject({ text: 'not a card\n', lane: 'lane-7', card_line: null, touches: null })
      expect(db.prepare('SELECT state FROM cards WHERE card_id = 90').get()).toEqual({ state: 'queued' })
    })
  })

  it('an admission without text leaves the body of the latest one that carried it', () => {
    const w = world()
    admit(w)
    withBus(w, (db) => {
      appendAdmission(db, 'without-text', { card: CARD, lane: 'lane-9' })
      reduce(db)
      expect(bodyRow(db)).toMatchObject({ admission_event_id: admissionIds(db)[0], lane: WINDOW_LANE })
    })
  })
})

describe('the admitted body intake and launch read back from card_bodies', () => {
  it('cardBodyText returns the folded text of a card and null for a card with no body', () => {
    const w = world()
    admit(w)
    withBus(w, (db) => {
      reduce(db)
      expect(cardBodyText(db, 90)).toBe(readFileSync(w.file, 'utf8'))
      expect(cardBodyText(db, 91)).toBeNull()
    })
  })

  it('an intake admission with no card_bodies row is returned as it was recorded, with no text', () => {
    const w = world()
    admit(w)
    withBus(w, (db) => {
      const admission = busCardAdmissions(db)(90)
      expect(admission).toEqual(intakeAdmissions(db).at(-1))
      expect(admission).not.toHaveProperty('text')
    })
  })

  it('the text an intake admission carries is the card_bodies text, not the payload of that admission', () => {
    const w = world()
    admit(w)
    const later = readFileSync(w.file, 'utf8').replace('Do the thing.', 'Do the later thing.')
    withBus(w, (db) => {
      appendEvent(db, { ts: '2026-10-13T10:00:00.000Z', type: CARD_ADMITTED, actor: 'policy', cardId: 90, pr: null, head: null, dedupeKey: 'policy-later', payload: { card: CARD, lane: 'lane-7', text: later, textSha: sha256(later) }, legacy: false })
      reduce(db)
      expect(busCardAdmissions(db)(90)).toMatchObject({ card: CARD, text: later })
      expect(busCardAdmissions(db)(91)).toBeNull()
    })
  })
})
