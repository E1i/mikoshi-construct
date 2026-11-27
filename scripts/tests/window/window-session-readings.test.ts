import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WINDOW_WHO } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { RUNNING_CARD } from '../../core/card-automaton.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_SESSION_ENDED, CARD_STARTED, MERGE_DONE, NODE_DETECTED, PR_OBSERVED, REVIEW_RECORDED, WINDOW_HEARTBEAT, WITNESS_RECORDED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { WORKTREE_HOME_VARIABLE } from '../../ports/worktree-home.js'
import { busProjections } from '../../supervisor/composition.js'
import { findingsOf } from '../../window/card-measure.js'
import { busMerged } from '../../window/handoff-write.js'
import { operatorWorkSince } from '../../window/operator-work.js'
import { lastWindowBeat, ownCardWithoutPr } from '../../window/turn-watch.js'
import { productionDeps } from '../../window/watch.js'
import { openCardTreesOf } from '../../window/window-agents.js'
import { SESSION_JOURNAL, WindowSessionEnds } from '../../window/window-session-end.js'
import { windowOf } from '../../window/window.js'

const ACTOR = 'worker:test:window-session'
const STARTER = 'worker:start:window-session'
const HEAD_1 = '1'.repeat(40)
const HEAD_2 = '2'.repeat(40)
const T0 = Date.parse('2026-11-20T10:00:00.000Z')
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'window-session-readings-'))
  roots.push(root)
  return root
}

interface Written { type: string, card?: number | null, pr?: number | null, head?: string | null, payload?: Record<string, unknown>, ts?: string, actor?: string, key?: string }

let serial = 0

function write(db: DatabaseSync, event: Written): number {
  serial += 1
  appendEvent(db, { ts: event.ts ?? at(serial), type: event.type, actor: event.actor ?? ACTOR, cardId: event.card ?? null, pr: event.pr ?? null, head: event.head ?? null, dedupeKey: event.key ?? `test:${serial}`, payload: event.payload ?? {}, legacy: false })
  return Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function withBus<T>(story: (db: DatabaseSync, bus: string) => T): T {
  const bus = path.join(scratch(), 'bus.db')
  const db = openBus(bus)
  try {
    return story(db, bus)
  }
  finally {
    db.close()
  }
}

describe('miko:watch reads observed heads and the last event of each pull request through the events contract', () => {
  it('names the heads of a pull request in the order they were last observed', () => {
    withBus((db, bus) => {
      write(db, { type: PR_OBSERVED, pr: 7, head: HEAD_1 })
      write(db, { type: PR_OBSERVED, pr: 7, head: HEAD_2 })
      const last = write(db, { type: PR_OBSERVED, pr: 7, head: HEAD_1 })
      expect(productionDeps(path.dirname(bus), bus).observedHeads(7, last + 1)).toEqual([HEAD_2, HEAD_1])
    })
  })

  it('keeps the last observation and the last witness of every pull request of one card', () => {
    withBus((db, bus) => {
      const ids = [PR_OBSERVED, WITNESS_RECORDED].flatMap(type => [write(db, { type, card: 9, pr: 7 }), write(db, { type, card: 9, pr: 8 })])
      const deps = productionDeps(path.dirname(bus), bus)
      expect(deps.observedUpTo(ids.at(-1)!).map(event => event.id)).toEqual(ids.slice(0, 2))
      expect(deps.witnessedUpTo(ids.at(-1)!).map(event => event.id)).toEqual(ids.slice(2))
    })
  })
})

describe('the operator work cursor wakes on a new head of an observed pull request only', () => {
  it('skips a repeated observation of the same head and stops at the first new head', () => {
    withBus((db) => {
      const first = write(db, { type: PR_OBSERVED, pr: 7, head: HEAD_1 })
      write(db, { type: PR_OBSERVED, pr: 7, head: HEAD_1 })
      const moved = write(db, { type: PR_OBSERVED, pr: 7, head: HEAD_2 })
      expect(operatorWorkSince(db, first)).toBe(moved)
    })
  })
})

const OWN_CARD = 4140

function windowCard(db: DatabaseSync, who: string = WINDOW_WHO): void {
  const line = `#${OWN_CARD} own [implement/construct/XS/cheap/auto] · depends — · blocks —`
  const text = `card: ${line}\nbranch: feat/${OWN_CARD}\ntouches: scripts/${OWN_CARD}/**\nwho: ${who}\n\ndo ${OWN_CARD}\n`
  write(db, { type: CARD_ADMITTED, card: OWN_CARD, payload: { card: line, lane: 'lane-1', depends: [], text, textSha: textSha(text) } })
  write(db, { type: CARD_STARTED, card: OWN_CARD, payload: { session: 's-window', worktree: `/trees/${OWN_CARD}`, branch: `feat/${OWN_CARD}` } })
  reduce(db, 'pending', busProjections())
}

describe('turn-watch reads the window cards and its beats through their owners', () => {
  it('a running window card that has its pull request is not a card without one', () => {
    withBus((db) => {
      windowCard(db)
      expect(ownCardWithoutPr(db)).toBe(OWN_CARD)
      db.prepare('UPDATE cards SET pr = 77 WHERE card_id = ?').run(OWN_CARD)
      expect(ownCardWithoutPr(db)).toBeNull()
    })
  })

  it('the last beat of a session is its own, not a newer beat of another session that names it', () => {
    withBus((db) => {
      write(db, { type: WINDOW_HEARTBEAT, payload: { session: 's-1' }, ts: at(1) })
      write(db, { type: WINDOW_HEARTBEAT, payload: { session: 's-2', root: '/trees/s-1' }, ts: at(2) })
      expect(lastWindowBeat(db, 's-1')).toBe(at(1))
    })
  })
})

describe('the window agents name the trees of the window cards that are still open', () => {
  it('leaves out a card that has no state', () => {
    withBus((db, bus) => {
      const home = scratch()
      windowCard(db)
      mkdirSync(path.join(home, `mc-${OWN_CARD}`))
      const env = { [WORKTREE_HOME_VARIABLE]: home }
      expect(db.prepare('SELECT state FROM cards WHERE card_id = ?').get(OWN_CARD)).toEqual({ state: RUNNING_CARD })
      expect(openCardTreesOf(db, env, bus)).toEqual([path.join(home, `mc-${OWN_CARD}`)])
      db.prepare('UPDATE cards SET state = NULL WHERE card_id = ?').run(OWN_CARD)
      expect(openCardTreesOf(db, env, bus)).toEqual([])
    })
  })
})

describe('the window session sweep records the end of a window session once', () => {
  function journal(root: string, session: string, end: string): void {
    mkdirSync(path.join(root, path.dirname(SESSION_JOURNAL)), { recursive: true })
    writeFileSync(path.join(root, SESSION_JOURNAL), `${JSON.stringify({ kind: 'session-end', session, at: end })}\n`)
  }

  function windowStart(db: DatabaseSync, root: string): void {
    write(db, { type: CARD_STARTED, card: OWN_CARD, actor: STARTER, ts: at(0), payload: { session: 's-w', worktree: root } })
    journal(root, 's-w', at(5))
  }

  it('does not sweep a start whose session has already ended', () => {
    withBus((db) => {
      const root = scratch()
      windowStart(db, root)
      write(db, { type: CARD_SESSION_ENDED, card: OWN_CARD, ts: at(6), payload: { session: 's-w', stopped: false } })
      expect(new WindowSessionEnds(db, root, () => T0 + 3_600_000).step()).toEqual([])
    })
  })

  it('a beat of another session that only names this one does not hold the end back', () => {
    withBus((db) => {
      const root = scratch()
      windowStart(db, root)
      write(db, { type: WINDOW_HEARTBEAT, ts: at(9), payload: { session: 's-other', root: `/trees/s-w` } })
      expect(new WindowSessionEnds(db, root, () => T0 + 3_600_000).step()).toEqual([`${CARD_SESSION_ENDED} #${OWN_CARD}: its window session s-w ended at ${at(5)}`])
    })
  })
})

describe('bus:window counts one task per completion and a detection before it', () => {
  const KEY = `merge:${OWN_CARD}:7:${HEAD_2}`

  function task(db: DatabaseSync, key: string, head: string, eventId: number): void {
    db.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES (?, \'merge\', ?, 7, ?, \'done\', ?)').run(key, OWN_CARD, head, eventId)
  }

  function detected(db: DatabaseSync): number {
    return write(db, { type: NODE_DETECTED, key: `${NODE_DETECTED}:merge:${KEY}`, payload: { key: KEY, via: 'event', outcome: 'queued' } })
  }

  it('takes the task of the completed head, not the task of an earlier head of the same pull request', () => {
    withBus((db) => {
      const id = detected(db)
      task(db, `merge:${OWN_CARD}:7:${HEAD_1}`, HEAD_1, id)
      task(db, KEY, HEAD_2, id)
      const done = write(db, { type: MERGE_DONE, card: OWN_CARD, pr: 7, head: HEAD_2 })
      expect(windowOf(db, 'merge')).toMatchObject({ run: [{ key: KEY, completion: done, detected: id, tasks: 1 }], stop: null })
    })
  })

  it('a detection written after the completion does not count', () => {
    withBus((db) => {
      const done = write(db, { type: MERGE_DONE, card: OWN_CARD, pr: 7, head: HEAD_2 })
      task(db, KEY, HEAD_2, done)
      detected(db)
      expect(windowOf(db, 'merge')).toMatchObject({ run: [], stop: { id: done, cardId: OWN_CARD } })
    })
  })
})

describe('the card measure and handoff:write read the merges through the events contract', () => {
  it('a card merged twice is measured in the column of its last merge', () => {
    withBus((db) => {
      write(db, { type: MERGE_DONE, card: OWN_CARD, ts: at(0) })
      write(db, { type: REVIEW_RECORDED, card: OWN_CARD, pr: 7, payload: { verdict: 'changes', findings: ['a finding'] } })
      write(db, { type: MERGE_DONE, card: OWN_CARD, ts: at(100) })
      expect(findingsOf(db, { before: at(10), after: at(90) }, 'unclassified').map(finding => finding.column)).toEqual(['after'])
    })
  })

  it('handoff:write counts the cards merged since the start only', () => {
    withBus((db, bus) => {
      write(db, { type: MERGE_DONE, card: 1, ts: at(0) })
      write(db, { type: MERGE_DONE, card: 2, ts: at(20) })
      expect(busMerged(bus, at(10))).toMatchObject({ kind: 'read', cards: [2] })
    })
  })
})
