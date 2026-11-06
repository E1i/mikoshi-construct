import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { BUS_PULSE, CARD_HELD, CARD_RELEASED, PR_OPENED } from '../../core/events.js'
import { prClosed, prObserved } from '../../core/observations.js'
import { reduce } from '../../core/reducer.js'
import { productionDeps, STALL_MS } from '../../window/watch.js'

const CARD = 1631
const PR = 1405
const RECUT = 1406
const HEAD = 'a'.repeat(40)
const ACTOR = 'worker:test:watch-held-card'
const LONG_AGO = new Date(Date.now() - STALL_MS - 60_000).toISOString()

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function opened(db: DatabaseSync, pr: number): void {
  appendEvent(db, { ts: LONG_AGO, type: PR_OPENED, actor: ACTOR, cardId: CARD, pr, head: null, dedupeKey: `${PR_OPENED}:${pr}`, payload: { pr, lease_gen: 0 }, legacy: false })
  appendEvent(db, prObserved(LONG_AGO, { pr, cardId: CARD, base: 'main', head: HEAD, branch: null, mergeable: 'clean', ci: 'pending', failedChecks: [], verdictOnHead: null, autoMerge: false, draft: false, bodySha: 'body' }, null))
}

function closed(db: DatabaseSync, pr: number): void {
  appendEvent(db, prClosed(LONG_AGO, { pr, cardId: CARD, merged: false, commit: null, mergedBy: null, mergedAt: null }))
}

function held(db: DatabaseSync): void {
  appendEvent(db, { ts: LONG_AGO, type: CARD_HELD, actor: ACTOR, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_HELD}:${CARD}`, payload: { reason: 'the owner closed its pull request on purpose' }, legacy: false })
}

function released(db: DatabaseSync): void {
  appendEvent(db, { ts: LONG_AGO, type: CARD_RELEASED, actor: ACTOR, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_RELEASED}:${CARD}`, payload: {}, legacy: false })
}

function stalledCards(story: (db: DatabaseSync) => void): number[] {
  const root = mkdtempSync(path.join(tmpdir(), 'miko-watch-held-'))
  roots.push(root)
  const bus = path.join(root, 'bus.db')
  const db = openBus(bus)
  try {
    opened(db, PR)
    story(db)
    appendEvent(db, { ts: new Date().toISOString(), type: BUS_PULSE, actor: ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${BUS_PULSE}:alive`, payload: {}, legacy: false })
    reduce(db)
  }
  finally {
    db.close()
  }
  return productionDeps(root, bus).stalls().map(stall => stall.cardId)
}

describe('the stall alarm and a held card', () => {
  it('a held card with a closed pull request raises no stall', () => {
    expect(stalledCards((db) => {
      held(db)
      closed(db, PR)
    })).toEqual([])
  })

  it('a pull request closed before the hold raises no stall either', () => {
    expect(stalledCards((db) => {
      closed(db, PR)
      held(db)
    })).toEqual([])
  })

  it('a held card with an open pull request still raises a stall', () => {
    expect(stalledCards(held)).toEqual([CARD])
  })

  it('a held card re-cut to an open pull request still raises a stall', () => {
    expect(stalledCards((db) => {
      held(db)
      closed(db, PR)
      opened(db, RECUT)
    })).toEqual([CARD])
  })

  it('a card with no hold and a closed pull request still raises a stall', () => {
    expect(stalledCards(db => closed(db, PR))).toEqual([CARD])
  })

  it('a card with no hold and an open pull request still raises a stall', () => {
    expect(stalledCards(() => {})).toEqual([CARD])
  })

  it('a hold released after the close raises the stall again', () => {
    expect(stalledCards((db) => {
      held(db)
      closed(db, PR)
      released(db)
    })).toEqual([CARD])
  })
})
