import type { DatabaseSync } from 'node:sqlite'
import type { BackfillSet } from '../../bus/backfill.js'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { CARD_ADMITTED, CARD_MOVED } from '../../../src/commands/intake/index.js'
import { BACKFILL_ACTOR, recordSet, runBackfill, runBackfillCommand, USAGE } from '../../bus/backfill.js'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { cardChain } from '../../bus/card-chain.js'
import { appendEvent, BUS_DB_VARIABLE, openBus } from '../../bus/db.js'
import { CARD_STARTED } from '../../bus/inbox.js'
import { busIntakePorts } from '../../bus/intake.js'
import { launchCandidates } from '../../bus/launch-candidates.js'
import { CARD_CLOSED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { replayDifferences } from '../../bus/report.js'
import { cardVerified, mergeBench } from './merge-bench.js'

const AFTER_THE_CUTOFF = new Date('2026-10-13T09:00:00.000Z')
const BACKFILLED_AT = new Date('2026-10-15T09:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, journal: string, repo: string, bus: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'backfill-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(parking, 'lane-7'), { recursive: true })
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  return { root, parking, journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo, bus }
}

function cardText(card: number, body = 'Do the thing.'): string {
  return `card: #${card} card-${card} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${card}\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\n${body}\n`
}

function park(w: World, card: number, lane: string | null = 'lane-7', body?: string): string {
  const file = path.join(lane === null ? w.parking : path.join(w.parking, lane), `${card}.md`)
  writeFileSync(file, cardText(card, body))
  return file
}

function withBus<T>(w: World, work: (db: DatabaseSync) => T): T {
  const db = openBus(w.bus)
  try {
    return work(db)
  }
  finally {
    db.close()
  }
}

function admit(w: World, file: string): void {
  withBus(w, (db) => {
    const ports = busIntakePorts(db, 's1')
    runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => AFTER_THE_CUTOFF)
  })
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function append(db: DatabaseSync, type: string, cardId: number, key: string, payload: Record<string, unknown>, legacy = false): void {
  appendEvent(db, { ts: '2026-10-13T10:00:00.000Z', type, actor: 'worker:test:t1', cardId, pr: null, head: null, dedupeKey: key, payload, legacy })
}

function backfillEvents(db: DatabaseSync): { card_id: number, actor: string, payload: Record<string, unknown> }[] {
  return (db.prepare(`SELECT card_id, actor, payload FROM events WHERE type = '${CARD_ADMITTED}' AND json_extract(payload, '$.source') = 'backfill' ORDER BY id`).all() as { card_id: number, actor: string, payload: string }[])
    .map(row => ({ card_id: row.card_id, actor: row.actor, payload: JSON.parse(row.payload) as Record<string, unknown> }))
}

function eventCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
}

function liveWorld(): World {
  const w = world()
  admit(w, park(w, 90))
  park(w, 91, null)
  park(w, 92)
  return w
}

function recorded(w: World): BackfillSet {
  return withBus(w, db => recordSet(db, w.parking, BACKFILLED_AT).set)
}

function backfilled(w: World, set: BackfillSet): ReturnType<typeof runBackfill> {
  return withBus(w, (db) => {
    const result = runBackfill(db, set, BACKFILLED_AT)
    reduce(db)
    return result
  })
}

function settle(w: World): void {
  withBus(w, (db) => {
    append(db, 'merge', 93, 'merge:93', { task: '93' }, true)
    append(db, MERGE_DONE, 94, `${MERGE_DONE}:94`, {})
    append(db, CARD_CLOSED, 94, `${CARD_CLOSED}:94`, { verification: 'run' })
    const text = cardText(95)
    append(db, CARD_ADMITTED, 95, `${CARD_ADMITTED}:95`, { card: `#95`, lane: 'lane-7', text, textSha: sha256(text) })
    append(db, CARD_STARTED, 95, `${CARD_STARTED}:95`, {})
    append(db, CARD_MOVED, 95, `${CARD_MOVED}:95`, { lane: 'dropped' })
    reduce(db)
  })
}

describe('the backfill admits every live parked card once, from a fixed set', () => {
  it('the backfill writes one card.admitted with source backfill per card of the fixed set', () => {
    const w = liveWorld()
    const set = recorded(w)
    expect(set.cards.map(entry => entry.card)).toEqual([90, 91, 92])
    expect(backfilled(w, set)).toEqual({ written: 3, unchanged: 0 })
    withBus(w, (db) => {
      const events = backfillEvents(db)
      expect(events.map(event => event.card_id)).toEqual([90, 91, 92])
      for (const event of events) {
        const text = readFileSync(set.cards.find(entry => entry.card === event.card_id)!.file, 'utf8')
        expect(event.actor).toBe(BACKFILL_ACTOR)
        expect(event.payload).toMatchObject({ source: 'backfill', text, textSha: sha256(text), textVerified: false })
        expect(typeof event.payload.bodyMatchesAdmission).toBe('boolean')
      }
      expect(events.find(event => event.card_id === 91)!.payload).toMatchObject({ lane: null, bodyMatchesAdmission: false, prevAdmissionId: null })
      expect(events.find(event => event.card_id === 90)!.payload.prevAdmissionId).toEqual(expect.any(Number))
    })
  })

  it('after the backfill card_bodies matches the files of the set', () => {
    const w = liveWorld()
    const set = recorded(w)
    backfilled(w, set)
    withBus(w, (db) => {
      const bodies = db.prepare('SELECT card_id, text, text_sha FROM card_bodies ORDER BY card_id').all() as { card_id: number, text: string, text_sha: string }[]
      expect(bodies.map(row => row.card_id)).toEqual([90, 91, 92])
      for (const row of bodies) {
        const entry = set.cards.find(each => each.card === row.card_id)!
        expect(row.text_sha).toBe(entry.textSha)
        expect(sha256(row.text)).toBe(entry.textSha)
        expect(row.text).toBe(readFileSync(entry.file, 'utf8'))
      }
    })
  })

  it('a second run on the same set writes no new event', () => {
    const w = liveWorld()
    const set = recorded(w)
    backfilled(w, set)
    const before = withBus(w, eventCount)
    expect(backfilled(w, set)).toEqual({ written: 0, unchanged: 3 })
    expect(withBus(w, eventCount)).toBe(before)
  })

  it('replay after the backfill rebuilds the same card_bodies', () => {
    const w = liveWorld()
    backfilled(w, recorded(w))
    withBus(w, (db) => {
      expect(replayDifferences(db).differences).toEqual([])
      const before = projectionDump(db)
      reduce(db)
      expect(projectionDump(db)).toBe(before)
    })
  })

  it('a merged, closed or dropped card gets no backfill event', () => {
    const w = liveWorld()
    for (const card of [93, 94, 95])
      park(w, card)
    settle(w)
    const set = recorded(w)
    expect(set.cards.map(entry => entry.card)).toEqual([90, 91, 92])
    backfilled(w, set)
    withBus(w, (db) => {
      expect(backfillEvents(db).map(event => event.card_id)).toEqual([90, 91, 92])
      expect(db.prepare('SELECT card_id, state FROM cards WHERE card_id IN (94, 95) ORDER BY card_id').all()).toEqual([
        { card_id: 94, state: 'closed' },
        { card_id: 95, state: 'dropped' },
      ])
    })
  })

  it('a backfill leaves card state and launch candidates as they were', () => {
    const w = liveWorld()
    const lifecycle = (db: DatabaseSync): unknown => ({ cards: db.prepare('SELECT * FROM cards ORDER BY card_id').all(), candidates: launchCandidates(db) })
    const before = withBus(w, (db) => {
      reduce(db)
      return lifecycle(db)
    })
    backfilled(w, recorded(w))
    expect(withBus(w, lifecycle)).toEqual(before)
  })

  it('a backfill admission without depends leaves the merge queue on the depends of the latest real admission', () => {
    const bench = mergeBench()
    try {
      const pr = 997
      const card = pr + 100
      const text = cardText(card)
      bench.gitHub.open({ number: pr, review: 'success' })
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:test:t1', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:intake:${card}`, payload: { lane: 'lane-7', depends: [card + 1], decision: null, contour: null }, legacy: false })
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: BACKFILL_ACTOR, cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:backfill:${card}`, payload: { card: `#${card}`, lane: 'lane-7', source: 'backfill', text, textSha: sha256(text), bodyMatchesAdmission: false, textVerified: false }, legacy: false })
      bench.tick()

      expect(bench.lease()).toBeNull()
    }
    finally {
      bench.close()
    }
  })

  it('a set whose file changed since it was recorded writes nothing', () => {
    const w = liveWorld()
    const set = recorded(w)
    const before = withBus(w, eventCount)
    park(w, 92, 'lane-7', 'Do the other thing.')
    expect(withBus(w, db => runBackfill(db, set, BACKFILLED_AT))).toEqual([`#92 ${path.join(w.parking, 'lane-7', '92.md')}: its sha is no longer the one the set recorded`])
    expect(withBus(w, eventCount)).toBe(before)
  })
})

interface Ran { code: number, out: string[], err: string[] }

function command(w: World, args: string[], parking = path.join(w.root, 'no-parking')): Ran {
  const out: string[] = []
  const err: string[] = []
  const code = runBackfillCommand(args, { bus: w.bus, parking, now: () => BACKFILLED_AT, out: line => out.push(line), err: line => err.push(line) })
  return { code, out, err }
}

describe('pnpm bus:backfill records a set and runs it', () => {
  it('--record writes the set, names every skipped card with its reason and exits 0', () => {
    const w = liveWorld()
    for (const card of [93, 94, 95])
      park(w, card)
    settle(w)
    const refused = path.join(w.parking, 'lane-7', '96.md')
    writeFileSync(refused, 'card: #96 not-a-card\n')
    const file = path.join(w.root, 'set.json')
    const ran = command(w, ['--record', file], w.parking)
    expect(ran.code).toBe(0)
    expect(ran.err).toEqual([])
    const set = JSON.parse(readFileSync(file, 'utf8')) as BackfillSet
    expect(set).toMatchObject({ recordedAt: BACKFILLED_AT.toISOString(), parking: w.parking })
    expect(set.cards.map(entry => entry.card)).toEqual([90, 91, 92])
    expect(ran.out.slice(0, 3)).toEqual([93, 94, 95].map(card => `[backfill] skipped #${card} ${path.join(w.parking, 'lane-7', `${card}.md`)}: settled in the bus`))
    expect(ran.out[3]).toMatch(new RegExp(`^\\[backfill\\] skipped #96 ${refused.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: refused by the card grammar: `))
    expect(ran.out.slice(4)).toEqual([`[backfill] recorded 3 cards in ${file}`])
  })

  it('--record --parking reads that directory, not the default parking', () => {
    const w = liveWorld()
    const file = path.join(w.root, 'set.json')
    expect(command(w, ['--record', file, '--parking', w.parking]).code).toBe(0)
    expect((JSON.parse(readFileSync(file, 'utf8')) as BackfillSet).cards.map(entry => entry.card)).toEqual([90, 91, 92])
  })

  it('--record refuses a set file that exists, leaves it as it was and exits 1', () => {
    const w = liveWorld()
    const file = path.join(w.root, 'set.json')
    writeFileSync(file, 'kept\n')
    const ran = command(w, ['--record', file], w.parking)
    expect(ran).toEqual({ code: 1, out: [], err: [`[backfill] ${file} exists; a recorded set is never overwritten`] })
    expect(readFileSync(file, 'utf8')).toBe('kept\n')
  })

  it('--set writes the set, a second --set writes nothing, and both exit 0', () => {
    const w = liveWorld()
    const file = path.join(w.root, 'set.json')
    command(w, ['--record', file], w.parking)
    expect(command(w, ['--set', file])).toEqual({ code: 0, out: ['[backfill] 3 written, 0 already backfilled, 3 in the set'], err: [] })
    expect(command(w, ['--set', file])).toEqual({ code: 0, out: ['[backfill] 0 written, 3 already backfilled, 3 in the set'], err: [] })
    expect(withBus(w, db => backfillEvents(db).map(event => event.card_id))).toEqual([90, 91, 92])
  })

  it('--set on a set whose file changed names the change, writes nothing and exits 1', () => {
    const w = liveWorld()
    const file = path.join(w.root, 'set.json')
    command(w, ['--record', file], w.parking)
    const before = withBus(w, eventCount)
    park(w, 92, 'lane-7', 'Do the other thing.')
    expect(command(w, ['--set', file])).toEqual({ code: 1, out: [], err: [`[backfill] #92 ${path.join(w.parking, 'lane-7', '92.md')}: its sha is no longer the one the set recorded`, '[backfill] nothing written; record a new set'] })
    expect(withBus(w, eventCount)).toBe(before)
  })

  it.each([[[]], [['--record']], [['--set']], [['--set', 'a.json', 'extra']], [['--record', 'a.json', '--parking']], [['--record', 'a.json', '--lane', 'x']], [['--run', 'a.json']]])('%j is refused with the usage and exit 2', (args) => {
    const w = world()
    expect(command(w, args)).toEqual({ code: 2, out: [], err: [`[backfill] ${USAGE}`] })
  })
})

describe('the chain of a card is recovered by admission ids', () => {
  it('the chain card, version, decision, verdict and proof is recovered by admission ids for a closed card', () => {
    const w = world()
    const file = park(w, 96, 'lane-7', 'Under D-121.')
    admit(w, file)
    writeFileSync(file, cardText(96, 'Under D-121 and D-124.'))
    admit(w, file)
    withBus(w, (db) => {
      append(db, MERGE_DONE, 96, `${MERGE_DONE}:96`, {})
      append(db, REVIEW_RECORDED, 96, `${REVIEW_RECORDED}:96`, { verdict: 'pass', findings: [] })
      cardVerified(db, '2026-10-13T11:00:00.000Z', 96, 996)
      append(db, CARD_CLOSED, 96, `${CARD_CLOSED}:96`, { verification: 'run' })
      reduce(db)
      const admissions = (db.prepare(`SELECT id FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = 96 ORDER BY id`).all() as { id: number }[]).map(row => row.id)
      const review = db.prepare(`SELECT id FROM events WHERE type = '${REVIEW_RECORDED}' AND card_id = 96`).get() as { id: number }
      const proof = db.prepare(`SELECT id FROM events WHERE type = 'card.verified' AND card_id = 96`).get() as { id: number }
      expect(db.prepare('SELECT state FROM cards WHERE card_id = 96').get()).toEqual({ state: 'closed' })
      expect(cardChain(db, 96)).toEqual({
        card: 96,
        versions: [admissions[1], admissions[0]],
        decisions: ['D-121', 'D-124'],
        verdict: { event: review.id, verdict: 'pass' },
        proof: proof.id,
      })
    })
  })
})
