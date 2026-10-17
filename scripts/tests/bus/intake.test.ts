import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runMain } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { CARD_ADMITTED, CARD_MOVED } from '../../../src/commands/intake/index.js'
import { runMove } from '../../../src/commands/intake/move.js'
import { createMain } from '../../../src/program.js'
import { parkingLane } from '../../bus/admissions.js'
import { BUS_DB_VARIABLE, openBus } from '../../bus/db.js'
import { importJournalFile } from '../../bus/import.js'
import { busCardEvents, busIntakePorts } from '../../bus/intake.js'

const NOW = new Date('2026-10-12T16:00:00.000Z')
const AFTER_THE_CUTOFF = new Date('2026-10-13T09:00:00.000Z')
const CARD = '#90 port-card [implement/netwatch/S/cheap/auto] · depends — · blocks —'
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, journal: string, repo: string, bus: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-intake-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  return { root, parking: path.join(root, 'parking'), journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo, bus: path.join(root, 'bus.db') }
}

function park(w: World, dir: string): string {
  const lane = path.join(w.parking, dir)
  mkdirSync(lane, { recursive: true })
  const file = path.join(lane, '90.md')
  writeFileSync(file, `card: ${CARD}\nbranch: feat/port-card\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
  return file
}

function cardEvents(w: World): Record<string, unknown>[] {
  const db = openBus(w.bus)
  try {
    return (db.prepare('SELECT type, actor, card_id, payload FROM events WHERE legacy = 0 ORDER BY id').all() as { type: string, actor: string, card_id: number, payload: string }[])
      .map(row => ({ type: row.type, actor: row.actor, cardId: row.card_id, payload: JSON.parse(row.payload) as unknown }))
  }
  finally {
    db.close()
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function admissions(w: World): { id: number, payload: Record<string, unknown> }[] {
  const db = openBus(w.bus)
  try {
    return (db.prepare(`SELECT id, payload FROM events WHERE type = '${CARD_ADMITTED}' ORDER BY id`).all() as { id: number, payload: string }[])
      .map(row => ({ id: row.id, payload: JSON.parse(row.payload) as Record<string, unknown> }))
  }
  finally {
    db.close()
  }
}

function appendEventRow(db: ReturnType<typeof openBus>): void {
  db.prepare('INSERT INTO events (ts, type, actor, card_id, dedupe_key, payload, legacy) VALUES (\'2026-10-12T12:00:00.000Z\', \'card.state\', \'test\', 80, \'seed\', \'{}\', 1)').run()
}

function withPort<T>(w: World, act: (events: ReturnType<typeof busCardEvents>) => T): T {
  const db = openBus(w.bus)
  try {
    return act(busCardEvents(db, 's1'))
  }
  finally {
    db.close()
  }
}

function admitThroughThePorts(w: World, file: string): string {
  const db = openBus(w.bus)
  try {
    const ports = busIntakePorts(db, 's1')
    return runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => AFTER_THE_CUTOFF).status
  }
  finally {
    db.close()
  }
}

describe('pnpm intake writes card events to bus.db', () => {
  it('an --admit through the port writes card.admitted to the bus as the intake worker', () => {
    const w = world()
    const file = park(w, 'lane-7')
    expect(withPort(w, events => runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events }, () => NOW)).status).toBe('admitted')
    expect(cardEvents(w)).toMatchObject([{ type: CARD_ADMITTED, actor: 'worker:intake:s1', cardId: 90, payload: { card: CARD, lane: 'lane-7', depends: [], decision: 'auto', contour: 'cheap' } }])
  })

  it('an --admit with the bus writes text, textSha, prevTextSha and prevAdmissionId', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const file = park(w, 'lane-7')
    const text = readFileSync(file, 'utf8')
    expect(admitThroughThePorts(w, file)).toBe('admitted')
    expect(admissions(w).map(admission => admission.payload)).toMatchObject([{ card: CARD, text, textSha: sha256(text), prevTextSha: null, prevAdmissionId: null }])
  })

  it('a second admission names the first as prevAdmissionId and its textSha as prevTextSha', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const file = park(w, 'lane-7')
    const first = readFileSync(file, 'utf8')
    expect(admitThroughThePorts(w, file)).toBe('admitted')
    const second = first.replace('Do the thing.', 'Do the other thing.')
    writeFileSync(file, second)
    expect(admitThroughThePorts(w, file)).toBe('admitted')
    const [earlier, later] = admissions(w)
    expect(later!.payload).toMatchObject({ text: second, textSha: sha256(second), prevAdmissionId: earlier!.id, prevTextSha: sha256(first) })
  })

  it('a move into a lane admits the moved text as a version with the same textSha and the new lane', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const text = readFileSync(park(w, ''), 'utf8')
    expect(admitThroughThePorts(w, path.join(w.parking, '90.md'))).toBe('admitted')
    expect(withPort(w, events => runMove({ move: '#90', to: 'lane-8', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => AFTER_THE_CUTOFF)).status).toBe('moved')
    const [admitted, moved] = admissions(w)
    expect(moved!.payload).toMatchObject({ lane: 'lane-8', text, textSha: sha256(text), prevAdmissionId: admitted!.id, prevTextSha: sha256(text) })
  })

  it('a move whose card.admitted append fails leaves no card.moved: the move and its admission are one transaction', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    expect(admitThroughThePorts(w, park(w, ''))).toBe('admitted')
    const db = openBus(w.bus)
    try {
      db.exec(`CREATE TRIGGER refuse_admission BEFORE INSERT ON events WHEN NEW.type = '${CARD_ADMITTED}' BEGIN SELECT RAISE(ABORT, 'admission refused'); END`)
      expect(() => runMove({ move: '#90', to: 'lane-8', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events: busCardEvents(db, 's1') }, () => AFTER_THE_CUTOFF)).toThrow('admission refused')
      expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${CARD_MOVED}'`).get()).toEqual({ n: 0 })
    }
    finally {
      db.close()
    }
  })

  it('an admission after one that carries no textSha names it as prevAdmissionId with prevTextSha null', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const file = park(w, 'lane-7')
    const db = openBus(w.bus)
    try {
      db.prepare(`INSERT INTO events (ts, type, actor, card_id, dedupe_key, payload, legacy) VALUES ('2026-10-12T12:00:00.000Z', '${CARD_ADMITTED}', 'test', 90, 'before-text', ?, 0)`).run(JSON.stringify({ card: CARD, bodySha: 'old' }))
    }
    finally {
      db.close()
    }
    expect(admitThroughThePorts(w, file)).toBe('admitted')
    const [earlier, later] = admissions(w)
    expect(later!.payload).toMatchObject({ prevAdmissionId: earlier!.id, prevTextSha: null })
  })

  it('a move into a lane writes card.moved and a card.admitted that carries the card and the lane', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    expect(admitThroughThePorts(w, park(w, ''))).toBe('admitted')
    expect(withPort(w, events => runMove({ move: '#90', to: 'lane-8', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => NOW)).status).toBe('moved')
    const [, moved, admitted] = cardEvents(w)
    expect(moved).toMatchObject({ type: CARD_MOVED, cardId: 90, payload: { lane: 'lane-8' } })
    expect(admitted).toMatchObject({ type: CARD_ADMITTED, actor: 'worker:intake:s1', cardId: 90, payload: { card: CARD, lane: 'lane-8', depends: [], decision: 'auto', contour: 'cheap' } })
  })

  it('a move into a directory that is no lane writes card.moved alone', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    expect(admitThroughThePorts(w, park(w, 'lane-7'))).toBe('admitted')
    expect(withPort(w, events => runMove({ move: '#90', to: 'notes', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => NOW)).status).toBe('moved')
    expect(cardEvents(w).map(event => event.type)).toEqual([CARD_ADMITTED, CARD_MOVED])
  })

  it('a move of a card with no card.admitted in the bus is refused, and the file stays where it was', () => {
    const w = world()
    const file = park(w, '')
    expect(() => withPort(w, events => runMove({ move: '#90', to: 'dropped', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => AFTER_THE_CUTOFF))).toThrow('#90 has no card.admitted in the bus')
    expect(existsSync(file)).toBe(true)
    expect(cardEvents(w)).toEqual([])
  })

  it('a backfilled card counts as admitted: its move into dropped is held by the bus', () => {
    const w = world()
    park(w, '')
    const db = openBus(w.bus)
    try {
      db.prepare(`INSERT INTO events (ts, type, actor, card_id, dedupe_key, payload, legacy) VALUES ('2026-10-12T12:00:00.000Z', '${CARD_ADMITTED}', 'worker:backfill:window', 90, 'backfilled', ?, 0)`).run(JSON.stringify({ card: CARD, source: 'backfill' }))
    }
    finally {
      db.close()
    }
    expect(withPort(w, events => runMove({ move: '#90', to: 'dropped', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => AFTER_THE_CUTOFF)).status).toBe('moved')
    expect(cardEvents(w).map(event => event.type)).toEqual([CARD_ADMITTED, CARD_MOVED])
  })

  it('with the bus a second --admit of an unchanged card is alreadyAdmitted, the bus holds one card.admitted and the journal no intake line', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const file = park(w, 'lane-7')
    const admitWithTheBus = (): string => {
      const db = openBus(w.bus)
      try {
        const ports = busIntakePorts(db, 's1')
        return runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => AFTER_THE_CUTOFF).status
      }
      finally {
        db.close()
      }
    }
    expect(admitWithTheBus()).toBe('admitted')
    expect(admitWithTheBus()).toBe('alreadyAdmitted')
    expect(cardEvents(w).filter(event => event.type === CARD_ADMITTED)).toHaveLength(1)
    expect(existsSync(w.journal)).toBe(false)
  })

  it('with the bus an unchanged card admitted again after an amend is alreadyAdmitted against the latest admission', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const file = park(w, 'lane-7')
    expect(admitThroughThePorts(w, file)).toBe('admitted')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Do the thing.', 'Do the other thing.'))
    expect(admitThroughThePorts(w, file)).toBe('admitted')
    expect(admitThroughThePorts(w, file)).toBe('alreadyAdmitted')
    expect(cardEvents(w).filter(event => event.type === CARD_ADMITTED)).toHaveLength(2)
  })

  it('with the bus a card admitted, then moved into a lane, is alreadyAdmitted, not amended', () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    expect(admitThroughThePorts(w, park(w, ''))).toBe('admitted')
    expect(withPort(w, events => runMove({ move: '#90', to: 'lane-8', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => AFTER_THE_CUTOFF)).status).toBe('moved')
    expect(admitThroughThePorts(w, path.join(w.parking, 'lane-8', '90.md'))).toBe('alreadyAdmitted')
  })

  it('the one-time import does not admit a second time a card the port admitted', () => {
    const w = world()
    const file = park(w, 'lane-7')
    withPort(w, events => runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events }, () => NOW))
    const db = openBus(w.bus)
    expect(importJournalFile(db, w.journal, parkingLane(w.parking), () => NOW)).toMatchObject({ imported: 1, admitted: 0 })
    db.close()
    expect(cardEvents(w).filter(event => event.type === CARD_ADMITTED)).toHaveLength(1)
  })

  it('the CLI createMain builds reaches the port with the intake command\'s --admit', async () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const file = park(w, '')
    const db = openBus(w.bus)
    try {
      await runMain(createMain(busIntakePorts(db)), { rawArgs: ['intake', '--admit', file, '--dir', w.repo, '--journal', w.journal, '--plain'] })
    }
    finally {
      db.close()
    }
    expect(cardEvents(w)).toMatchObject([{ type: CARD_ADMITTED, cardId: 90, payload: { card: CARD, lane: null } }])
    expect(existsSync(w.journal)).toBe(false)
  })

  it('through createMain an unchanged card admitted twice leaves one card.admitted in the bus', async () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const file = park(w, '')
    const db = openBus(w.bus)
    try {
      for (let run = 0; run < 2; run++)
        await runMain(createMain(busIntakePorts(db)), { rawArgs: ['intake', '--admit', file, '--dir', w.repo, '--journal', w.journal, '--plain'] })
    }
    finally {
      db.close()
    }
    expect(cardEvents(w).filter(event => event.type === CARD_ADMITTED)).toHaveLength(1)
  })

  it('the ports pnpm intake builds read the bus\'s card states, so --admit drops a depends the bus ended and keeps one merged in the journal only after its half of history while the bus runs it', async () => {
    const w = world()
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    const lane = path.join(w.parking, '')
    mkdirSync(lane, { recursive: true })
    const card = (id: number, depends: string): string => `#${id} dep-card-${id} [implement/netwatch/S/cheap/auto] · depends ${depends} · blocks —`
    const parkAs = (id: number, depends: string): string => {
      const file = path.join(lane, `${id}.md`)
      writeFileSync(file, `card: ${card(id, depends)}\nbranch: feat/dep-card-${id}\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
      return file
    }
    const db = openBus(w.bus)
    try {
      appendEventRow(db)
      db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (80, \'closed\', NULL, 1), (81, \'running\', NULL, 1)').run()
      mkdirSync(path.dirname(w.journal), { recursive: true })
      writeFileSync(w.journal, `${JSON.stringify({ event: 'merge', task: '81', pr: 181, by: 'E1i', commit: 'c0ffee', ts: '2026-10-12T18:00:00.000Z' })}\n`)
      const ended = parkAs(91, '#80')
      const late = parkAs(92, '#81')
      const main = createMain(busIntakePorts(db))
      await runMain(main, { rawArgs: ['intake', '--admit', ended, '--dir', w.repo, '--journal', w.journal, '--plain'] })
      await runMain(main, { rawArgs: ['intake', '--admit', late, '--dir', w.repo, '--journal', w.journal, '--plain'] })
    }
    finally {
      db.close()
    }
    expect(cardEvents(w).filter(event => event.type === CARD_ADMITTED).map(event => (event.payload as { card: string }).card)).toEqual([card(91, '—'), card(92, '#81')])
  })
})
