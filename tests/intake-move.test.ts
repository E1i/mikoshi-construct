import type { CardEvent, CardEventPort } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cardBodyText } from '../scripts/core/card-bodies.js'
import { openBus } from '../scripts/core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_MOVED } from '../scripts/core/events.js'
import { reduce } from '../scripts/core/reducer.js'
import { busCardEvents, busIntakePorts } from '../scripts/intake/intake.js'
import { launchCandidates } from '../scripts/nodes/launch/launch-candidates.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { runAmend } from '../src/commands/intake/amend.js'
import { bodySha } from '../src/commands/intake/confirm.js'
import { printMove, runMove } from '../src/commands/intake/move.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-07T09:00:00.000Z')
const AFTER_THE_CUTOFF = new Date('2026-10-13T09:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function world(): { parking: string, journal: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-move-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  return { parking, journal: path.join(root, 'handoff', 'ghosts.jsonl') }
}

function park(dir: string, id: number, body = 'Do the thing.', who = 'window'): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.md`)
  writeFileSync(file, `card: #${id} card-${id} [implement/black-ice/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: src/a.ts\ncontinue: stop\nwho: ${who}\n\n${body}\n`)
  return file
}

function move(w: { parking: string, journal: string }, id: number, to: string, events: CardEventPort = () => {}) {
  return runMove({ move: `#${id}`, to, draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events }, () => NOW)
}

function admitThenMove(w: { parking: string, journal: string }, events?: CardEventPort): void {
  const file = park(w.parking, 706)
  const repo = path.join(path.dirname(w.parking), 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  expect(runAdmit({ file, dir: repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events }, () => AFTER_THE_CUTOFF).status).toBe('admitted')
  expect(runMove({ move: '#706', to: 'lane-3', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events }, () => AFTER_THE_CUTOFF).status).toBe('moved')
}

function journalLines(journal: string): Record<string, unknown>[] {
  return existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function printed(result: ReturnType<typeof runMove>): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printMove(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

describe('intake --move', () => {
  it('moves a card to a parking directory and back, and each move takes the card off the queue', () => {
    const w = world()
    const file = park(w.parking, 700)
    const text = readFileSync(file, 'utf8')
    const bus: CardEvent[] = []
    expect(move(w, 700, 'after-0.42', event => bus.push(event)).status).toBe('moved')
    const moved = path.join(w.parking, 'after-0.42', '700.md')
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(moved, 'utf8')).toBe(text)
    expect(move(w, 700, '.', event => bus.push(event)).status).toBe('moved')
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(existsSync(moved)).toBe(false)
    expect(bus).toMatchObject([
      { type: CARD_DROPPED, cardId: 700, payload: { from: w.parking, to: path.join(w.parking, 'after-0.42'), bodySha: bodySha(text) } },
      { type: CARD_DROPPED, cardId: 700, payload: { from: path.join(w.parking, 'after-0.42'), to: w.parking, bodySha: bodySha(text) } },
    ])
    expect(journalLines(w.journal)).toEqual([])
  })

  it('a moved card writes card.moved to the bus and no journal line', () => {
    const w = world()
    const text = readFileSync(park(w.parking, 704), 'utf8')
    const bus: CardEvent[] = []
    expect(move(w, 704, 'lane-2', event => bus.push(event)).status).toBe('moved')
    const to = path.join(w.parking, 'lane-2')
    expect(bus).toEqual([{
      type: CARD_MOVED,
      cardId: 704,
      ts: NOW.toISOString(),
      dedupeKey: `${CARD_MOVED}:704:lane-2:${NOW.toISOString()}`,
      payload: { from: w.parking, to, bodySha: bodySha(text), lane: 'lane-2' },
    }])
    expect(journalLines(w.journal)).toEqual([])
  })

  it('with a connected bus after the cutoff intake writes no journal line', () => {
    const w = world()
    const bus: CardEvent[] = []
    admitThenMove(w, event => bus.push(event))
    expect(bus.map(event => event.type)).toEqual([CARD_ADMITTED, CARD_MOVED])
    expect(journalLines(w.journal)).toEqual([])
  })

  it('without a bus a move is refused: the file stays and no journal line holds a move', () => {
    const w = world()
    const file = park(w.parking, 708)
    const result = runMove({ move: '#708', to: 'lane-2', draft: undefined, taken: undefined, admit: undefined, parking: w.parking }, () => NOW)
    expect(printed(result)).toEqual({ lines: [expect.stringContaining('a move is held only by the bus')], exit: 1 })
    expect(existsSync(file)).toBe(true)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('a move into the lane that already holds the card writes card.moved and leaves the file where it is', () => {
    const w = world()
    const file = park(path.join(w.parking, 'lane-9'), 709)
    const text = readFileSync(file, 'utf8')
    const bus: CardEvent[] = []
    const result = move(w, 709, 'lane-9', event => bus.push(event))
    expect(result).toEqual({ status: 'recordedInPlace', file, event: CARD_MOVED })
    expect(printed(result).lines.join('\n')).toContain('the file was not moved')
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(bus).toMatchObject([{ type: CARD_MOVED, cardId: 709, payload: { from: path.dirname(file), to: path.dirname(file), lane: 'lane-9' } }])
  })

  it('a move into dropped writes card.dropped, not card.moved, also when the card already sits there', () => {
    const w = world()
    park(w.parking, 710)
    const inPlace = park(path.join(w.parking, 'dropped'), 711)
    const bus: CardEvent[] = []
    expect(move(w, 710, 'dropped', event => bus.push(event)).status).toBe('moved')
    const recorded = move(w, 711, 'dropped', event => bus.push(event))
    expect(recorded).toEqual({ status: 'recordedInPlace', file: inPlace, event: CARD_DROPPED })
    expect(printed(recorded).lines.join('\n')).toContain('The bus holds the move as card.dropped; the file was not moved.')
    const to = path.join(w.parking, 'dropped')
    expect(bus).toMatchObject([
      { type: CARD_DROPPED, cardId: 710, dedupeKey: `${CARD_DROPPED}:710:dropped:${NOW.toISOString()}`, payload: { from: w.parking, to, lane: 'dropped' } },
      { type: CARD_DROPPED, cardId: 711, payload: { from: to, to, lane: 'dropped' } },
    ])
  })

  it.each(['archive', 'superseded'])('a move into %s is a drop: it writes card.dropped and says so', (lane) => {
    const w = world()
    park(w.parking, 713)
    const bus: CardEvent[] = []
    const result = move(w, 713, lane, event => bus.push(event))
    expect(result).toMatchObject({ status: 'moved', event: CARD_DROPPED })
    expect(printed(result).lines.join('\n')).toContain('The bus holds the move as card.dropped; the card is unchanged.')
    expect(bus).toMatchObject([{ type: CARD_DROPPED, cardId: 713, payload: { lane } }])
  })

  it('a move the bus refuses puts the file back, removes the directory it created and leaves no journal line', () => {
    const w = world()
    const file = park(w.parking, 710)
    expect(() => move(w, 710, 'archive', () => {
      throw new Error('refused by the bus')
    })).toThrow('refused by the bus')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(path.join(w.parking, 'archive'))).toBe(false)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('a move the bus refuses into a directory that already existed keeps that directory', () => {
    const w = world()
    const file = park(w.parking, 711)
    park(path.join(w.parking, 'archive'), 712)
    expect(() => move(w, 711, 'archive', () => {
      throw new Error('refused by the bus')
    })).toThrow('refused by the bus')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(path.join(w.parking, 'archive', '712.md'))).toBe(true)
  })

  it.each(['2026-10-30-folded', 'after-0.42', 'notes', '.'])('a card moved into parking is no launch candidate: a move into %s writes card.dropped, never a fresh card.admitted', (to) => {
    const w = world()
    const db = openBus(path.join(path.dirname(w.parking), 'bus.db'))
    try {
      const events = busCardEvents(db, 'by-hand', () => 1)
      const file = park(path.join(w.parking, 'lane-window'), 1425, 'Fold the slice.', 'shift')
      const repo = path.join(path.dirname(w.parking), 'repo')
      mkdirSync(path.join(repo, 'src'), { recursive: true })
      writeFileSync(path.join(repo, 'src', 'a.ts'), '')
      expect(runAdmit({ file, dir: repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events }, () => AFTER_THE_CUTOFF).status).toBe('admitted')
      reduce(db)
      expect(launchCandidates(db, () => false).map(candidate => candidate.cardId)).toEqual([1425])
      const result = runMove({ move: '#1425', to, draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events }, () => AFTER_THE_CUTOFF)
      expect(result).toMatchObject({ status: 'moved', event: CARD_DROPPED })
      expect(reduce(db).rejected).toBe(0)
      const types = db.prepare('SELECT type FROM events WHERE card_id = 1425 ORDER BY id').all() as { type: string }[]
      expect(types.map(row => row.type).filter(type => type.startsWith('card.'))).toEqual([CARD_ADMITTED, CARD_DROPPED])
      expect(db.prepare('SELECT state FROM cards WHERE card_id = 1425').get()).toEqual({ state: 'dropped' })
      expect(launchCandidates(db, () => false).map(candidate => candidate.cardId)).toEqual([])
    }
    finally {
      db.close()
    }
  })

  it.each(['lane-3', 'night-2', '2026-10-30-a'])('a move into the launch lane %s writes card.moved', (lane) => {
    const w = world()
    park(w.parking, 714)
    const bus: CardEvent[] = []
    expect(move(w, 714, lane, event => bus.push(event))).toMatchObject({ status: 'moved', event: CARD_MOVED })
    expect(bus).toMatchObject([{ type: CARD_MOVED, cardId: 714, payload: { lane } }])
  })

  it('a bus-wired move says the bus holds the move', () => {
    const w = world()
    park(w.parking, 707)
    const { lines } = printed(move(w, 707, 'lane-2', () => {}))
    expect(lines.join('\n')).toContain('The bus holds the move as card.moved; the card is unchanged.')
  })

  it('a move into a missing directory creates it', () => {
    const w = world()
    park(w.parking, 701)
    expect(move(w, 701, 'later').status).toBe('moved')
    expect(existsSync(path.join(w.parking, 'later', '701.md'))).toBe(true)
  })

  it.each(['..', '../outside', '/tmp/elsewhere', 'a/b', ''])('refuses --to %j, which is not the root or one directory under it', (to) => {
    const w = world()
    const file = park(w.parking, 703)
    const result = move(w, 703, to)
    expect(result.status).toBe('refused')
    expect(printed(result).exit).toBe(1)
    expect(existsSync(file)).toBe(true)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('refuses a move onto a number already in the target directory as parked in more than one place', () => {
    const w = world()
    const file = park(w.parking, 702)
    const other = park(path.join(w.parking, 'later'), 702, 'Another.')
    const before = readFileSync(other, 'utf8')
    const result = move(w, 702, 'later')
    expect(result.status).toBe('refused')
    expect(printed(result).exit).toBe(1)
    expect(printed(result).lines.join('\n')).toContain('more than one place')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(other, 'utf8')).toBe(before)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('refuses a number found in more than one place, naming both paths', () => {
    const w = world()
    const a = park(w.parking, 703)
    const b = park(path.join(w.parking, 'after-0.42'), 703)
    const result = move(w, 703, 'later')
    expect(printed(result).lines.join('\n')).toContain(a)
    expect(printed(result).lines.join('\n')).toContain(b)
    expect(existsSync(a)).toBe(true)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('a sliced stub moves and its parent leaves the bus queue naming its children', () => {
    const w = world()
    const db = openBus(path.join(path.dirname(w.parking), 'bus.db'))
    try {
      const events = busCardEvents(db, 'by-hand', () => 1)
      const file = park(path.join(w.parking, 'lane-1'), 170)
      const repo = path.join(path.dirname(w.parking), 'repo')
      mkdirSync(path.join(repo, 'src'), { recursive: true })
      writeFileSync(path.join(repo, 'src', 'a.ts'), '')
      expect(runAdmit({ file, dir: repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events }, () => AFTER_THE_CUTOFF).status).toBe('admitted')
      reduce(db)
      expect(db.prepare('SELECT state FROM cards WHERE card_id = 170').get()).toEqual({ state: 'queued' })
      rmSync(file)
      const stub = path.join(w.parking, 'sliced', '170.md')
      mkdirSync(path.dirname(stub))
      writeFileSync(stub, 'sliced into #582, #583\n')
      const result = runMove({ move: '#170', to: 'sliced', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events }, () => AFTER_THE_CUTOFF)
      expect(result).toEqual({ status: 'recordedInPlace', file: stub, event: CARD_DROPPED })
      expect(reduce(db).rejected).toBe(0)
      expect(db.prepare('SELECT state FROM cards WHERE card_id = 170').get()).toEqual({ state: 'dropped' })
      const dropped = db.prepare(`SELECT payload FROM events WHERE type = '${CARD_DROPPED}' AND card_id = 170`).all() as { payload: string }[]
      expect(dropped.map(row => JSON.parse(row.payload))).toMatchObject([{ lane: 'sliced', children: [582, 583], reason: 'sliced into #582, #583' }])
    }
    finally {
      db.close()
    }
  })

  it('a sliced stub moved into a lane is still the parent\'s end, and a stub naming no child is refused', () => {
    const w = world()
    writeFileSync(path.join(w.parking, '171.md'), 'sliced into #584\n')
    writeFileSync(path.join(w.parking, '172.md'), 'sliced into nothing\n')
    const bus: CardEvent[] = []
    expect(move(w, 171, 'lane-2', event => bus.push(event))).toMatchObject({ status: 'moved', event: CARD_DROPPED })
    expect(bus).toMatchObject([{ type: CARD_DROPPED, cardId: 171, payload: { lane: 'lane-2', children: [584], reason: 'sliced into #584' } }])
    expect(move(w, 172, 'sliced').status).toBe('refused')
  })

  function admittedAndAmended(w: { parking: string }, db: ReturnType<typeof openBus>, ports: ReturnType<typeof busIntakePorts>): string {
    const file = park(w.parking, 1462)
    const repo = path.join(path.dirname(w.parking), 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    writeFileSync(path.join(repo, 'src', 'a.ts'), '')
    const admit = { dir: repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }
    expect(runAdmit({ ...admit, file }, () => AFTER_THE_CUTOFF).status).toBe('admitted')
    reduce(db)
    expect(runAmend({ ...admit, card: '#1462', flags: { note: 'The amended line.' } }, () => AFTER_THE_CUTOFF).status).toBe('admitted')
    return file
  }

  it('a move never reverts the amended body: while the projection lags it re-admits the latest card.admitted, and the moved card keeps the amended body after the fold', () => {
    const w = world()
    const db = openBus(path.join(path.dirname(w.parking), 'bus.db'))
    try {
      const ports = busIntakePorts(db, 'by-hand', () => 1)
      admittedAndAmended(w, db, ports)
      expect(cardBodyText(db, 1462)).not.toContain('The amended line.')
      const request = { move: '#1462', to: 'lane-3', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events: ports.cardEvents, admissions: ports.cardAdmissions }
      expect(runMove(request, () => AFTER_THE_CUTOFF).status).toBe('moved')
      expect(reduce(db).rejected).toBe(0)
      expect(cardBodyText(db, 1462)).toContain('The amended line.')
    }
    finally {
      db.close()
    }
  })

  it('a drop does not wait for the projection: card.dropped re-admits no body', () => {
    const w = world()
    const db = openBus(path.join(path.dirname(w.parking), 'bus.db'))
    try {
      const ports = busIntakePorts(db, 'by-hand', () => 1)
      admittedAndAmended(w, db, ports)
      const result = runMove({ move: '#1462', to: 'dropped', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events: ports.cardEvents, admissions: ports.cardAdmissions }, () => AFTER_THE_CUTOFF)
      expect(result).toMatchObject({ status: 'moved', event: CARD_DROPPED })
    }
    finally {
      db.close()
    }
  })

  it('refuses a card that is not parked and a card the grammar refuses', () => {
    const w = world()
    expect(move(w, 704, 'later').status).toBe('refused')
    const file = path.join(w.parking, '705.md')
    writeFileSync(file, 'not a card\n')
    expect(move(w, 705, 'later').status).toBe('refused')
    expect(existsSync(file)).toBe(true)
  })
})
