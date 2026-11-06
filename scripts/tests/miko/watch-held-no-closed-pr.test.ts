import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { RUNNING_CARD } from '../../core/card-automaton.js'
import { appendEvent, openBus } from '../../core/db.js'
import { BUS_PULSE, CARD_ADMITTED, CARD_ANSWERED, CARD_HELD, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { prClosed, prObserved } from '../../core/observations.js'
import { reduce } from '../../core/reducer.js'
import { productionDeps, STALL_MS } from '../../window/watch.js'

const CARD = 1703
const PR = 1433
const HEAD = 'a'.repeat(40)
const COMMIT = 'c'.repeat(40)
const ACTOR = 'worker:test:watch-held-no-closed-pr'
const LONG_AGO = new Date(Date.now() - STALL_MS - 60_000).toISOString()
const LINE = `#${CARD} held [implement/construct/XS/cheap/auto] · depends — · blocks —`
const TEXT = `card: ${LINE}\nbranch: feat/${CARD}\ntouches: scripts/${CARD}/**\nwho: shift\n\ndo ${CARD}\n`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function admitted(db: DatabaseSync): void {
  appendEvent(db, { ts: LONG_AGO, type: CARD_ADMITTED, actor: ACTOR, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: LINE, lane: 'lane-1', depends: [], text: TEXT, textSha: textSha(TEXT) }, legacy: false })
}

function started(db: DatabaseSync, ordinal: number): void {
  appendEvent(db, { ts: LONG_AGO, type: CARD_STARTED, actor: ACTOR, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:${ordinal}`, payload: { session: `s${ordinal}`, worktree: `/trees/${CARD}`, branch: `feat/${CARD}` }, legacy: false })
}

function merged(db: DatabaseSync): void {
  appendEvent(db, prObserved(LONG_AGO, { pr: PR, cardId: CARD, base: 'main', head: HEAD, branch: null, mergeable: 'clean', ci: 'green', failedChecks: [], verdictOnHead: null, autoMerge: false, draft: false, bodySha: 'body' }, null))
  appendEvent(db, prClosed(LONG_AGO, { pr: PR, cardId: CARD, merged: true, commit: COMMIT, mergedBy: 'bus', mergedAt: LONG_AGO }))
}

function stoppedAndAnswered(db: DatabaseSync): void {
  appendEvent(db, { ts: LONG_AGO, type: CARD_STOPPED, actor: ACTOR, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'review' }, legacy: false })
  appendEvent(db, { ts: LONG_AGO, type: CARD_ANSWERED, actor: ACTOR, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ANSWERED}:${CARD}`, payload: {}, legacy: false })
}

function held(db: DatabaseSync): void {
  appendEvent(db, { ts: LONG_AGO, type: CARD_HELD, actor: ACTOR, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_HELD}:${CARD}`, payload: { reason: 'the owner holds it' }, legacy: false })
}

interface Reading {
  cardState: string
  prStates: string[]
  stalled: number[]
}

function readingAfter(story: (db: DatabaseSync) => void): Reading {
  const root = mkdtempSync(path.join(tmpdir(), 'miko-watch-held-no-closed-'))
  roots.push(root)
  const bus = path.join(root, 'bus.db')
  const db = openBus(bus)
  try {
    story(db)
    appendEvent(db, { ts: new Date().toISOString(), type: BUS_PULSE, actor: ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${BUS_PULSE}:alive`, payload: {}, legacy: false })
    reduce(db)
    const card = db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD) as { state: string }
    const prs = db.prepare('SELECT state FROM prs WHERE card_id = ?').all(CARD) as unknown as Array<{ state: string }>
    return { cardState: card.state, prStates: prs.map(row => row.state), stalled: productionDeps(root, bus).stalls().map(stall => stall.cardId) }
  }
  finally {
    db.close()
  }
}

describe('the stall alarm and a held card with no closed pull request', () => {
  it('a held card with no pull request still raises a stall', () => {
    expect(readingAfter((db) => {
      admitted(db)
      started(db, 1)
      held(db)
    })).toEqual({ cardState: RUNNING_CARD, prStates: [], stalled: [CARD] })
  })

  it('a held card back in flight whose only pull request is merged still raises a stall', () => {
    expect(readingAfter((db) => {
      admitted(db)
      started(db, 1)
      merged(db)
      stoppedAndAnswered(db)
      started(db, 2)
      held(db)
    })).toEqual({ cardState: RUNNING_CARD, prStates: ['merged'], stalled: [CARD] })
  })
})
