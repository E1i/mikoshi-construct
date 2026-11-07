import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { readBusTasks } from '../../../src/commands/cost/bus.js'
import { cardChain } from '../../cli/card-chain.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, PR_CLOSED } from '../../core/events.js'
import { prClosed, prObserved } from '../../core/observations.js'
import { reduce } from '../../core/reducer.js'
import { mergesLinkedOnlyThroughThePr } from '../../release/evidence.js'
import { NO_PROGRESS_MS, readBoard } from '../../window/board.js'
import { sha } from '../bus/github-fake.js'

const CARD = 1800
const PR = 1801
const HEAD = sha('a')
const COMMIT = sha('c')
const STARTED_AT = '2026-11-04T10:00:00.000Z'
const MERGED_AT = '2026-11-04T10:10:00.000Z'
const LATER = '2026-11-04T10:30:00.000Z'
const MINUTES_TO_MERGE = 10
const BOARD_READ_AT = new Date(Date.parse(LATER) + 2 * NO_PROGRESS_MS)
const LINE = `#${CARD} ended [implement/netwatch/S/cheap/auto] · depends — · blocks —`
const TEXT = `card: ${LINE}\nbranch: feat/${CARD}\ntouches: scripts/${CARD}/**\nwho: shift\n\ndo ${CARD}\n`

interface Bench {
  db: DatabaseSync
  busPath: string
}

const benches: { root: string, db: DatabaseSync }[] = []

afterEach(() => {
  for (const bench of benches.splice(0)) {
    bench.db.close()
    rmSync(bench.root, { recursive: true, force: true })
  }
})

function admit(db: DatabaseSync, ts: string, ordinal: number): void {
  appendEvent(db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${ordinal}`, payload: { card: LINE, lane: 'lane-1', depends: [], text: TEXT, textSha: textSha(TEXT) }, legacy: false })
}

function start(db: DatabaseSync, ts: string, ordinal: number): void {
  appendEvent(db, { ts, type: CARD_STARTED, actor: 'worker:launch:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:${ordinal}`, payload: { session: `s${ordinal}`, worktree: `/trees/${CARD}`, branch: `feat/${CARD}` }, legacy: false })
  reduce(db)
}

function startedCard(): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'merged-card-readers-'))
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  benches.push({ root, db })
  admit(db, STARTED_AT, 1)
  start(db, STARTED_AT, 1)
  return { db, busPath }
}

function observedPr(bench: Bench, branch: string): void {
  appendEvent(bench.db, prObserved(STARTED_AT, { pr: PR, cardId: branch === `feat/${CARD}` ? CARD : null, base: 'main', head: HEAD, branch, mergeable: 'clean', ciFields: { ci: 'green' }, verdictOnHead: null, autoMerge: false, draft: false, bodySha: sha('d') }, null))
  reduce(bench.db)
}

function merge(bench: Bench, cardId: number | null): void {
  appendEvent(bench.db, prClosed(MERGED_AT, { pr: PR, cardId, merged: true, commit: COMMIT, mergedBy: 'bus', mergedAt: MERGED_AT }))
  reduce(bench.db)
}

function mergedThroughThePr(): Bench {
  const bench = startedCard()
  observedPr(bench, `feat/${CARD}`)
  merge(bench, null)
  return bench
}

function stopLate(bench: Bench): void {
  appendEvent(bench.db, { ts: LATER, type: CARD_STOPPED, actor: 'worker:launch:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'fault' }, legacy: false })
  reduce(bench.db)
}

function board(bench: Bench): ReturnType<typeof readBoard> {
  return readBoard({ db: bench.db, now: BOARD_READ_AT, watched: [], leaseOrders: {} })
}

function closedEvent(bench: Bench): number {
  return (bench.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(PR_CLOSED) as { id: number }).id
}

describe('a card with a merged pull request has ended, for all four readers', () => {
  it('a merged card is not in work and is counted in cost', () => {
    const bench = startedCard()
    observedPr(bench, `feat/${CARD}`)
    merge(bench, CARD)
    stopLate(bench)

    expect(board(bench).progress.stalled).toBe(false)
    expect(board(bench).blocked).toEqual([])
    expect(readBusTasks(bench.busPath).map(task => [task.task, task.minutes])).toEqual([[String(CARD), MINUTES_TO_MERGE]])
  })

  it('cost counts a card from a merge whose pr.closed names no card', () => {
    const bench = mergedThroughThePr()

    expect(readBusTasks(bench.busPath).map(task => [task.task, task.minutes])).toEqual([[String(CARD), MINUTES_TO_MERGE]])
  })

  it('the chain proves a card from a merge whose pr.closed names no card', () => {
    const bench = mergedThroughThePr()

    expect(cardChain(bench.db, CARD)?.proof).toBe(closedEvent(bench))
  })

  it('release:evidence finds the card of a merge whose pr.closed names no card', () => {
    const bench = mergedThroughThePr()

    expect(mergesLinkedOnlyThroughThePr(bench.busPath)).toEqual([{ task: String(CARD), pr: PR, by: 'bus', commit: COMMIT, merged: MERGED_AT, event: closedEvent(bench) }])
  })

  it('a pull request linked to no card ends no card', () => {
    const bench = startedCard()
    observedPr(bench, 'chore/no-card')
    merge(bench, null)

    expect(readBusTasks(bench.busPath)).toEqual([])
    expect(cardChain(bench.db, CARD)?.proof).toBeNull()
    expect(mergesLinkedOnlyThroughThePr(bench.busPath)).toEqual([])
    expect(board(bench).progress.stalled).toBe(true)
  })

  it('a card closed after its merge and started again is back in work', () => {
    const bench = mergedThroughThePr()
    appendEvent(bench.db, { ts: LATER, type: CARD_CLOSED, actor: 'worker:close:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${CARD}`, payload: { verification: 'run' }, legacy: false })
    reduce(bench.db)
    admit(bench.db, LATER, 2)
    start(bench.db, LATER, 2)

    expect(board(bench).progress.stalled).toBe(true)
  })
})
