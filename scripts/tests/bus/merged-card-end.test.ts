import type { DatabaseSync } from 'node:sqlite'
import type { EvidenceDeps } from '../../release/evidence.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { readBusTasks } from '../../../src/commands/cost/bus.js'
import { cardChain } from '../../cli/card-chain.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_STARTED, CARD_VERIFIED, PR_CLOSED, WITNESS_RECORDED } from '../../core/events.js'
import { prClosed, prObserved } from '../../core/observations.js'
import { reduce } from '../../core/reducer.js'
import { busIntakeAdmissions } from '../../intake/intake.js'
import { cardVerifiedClosings } from '../../nodes/close/task-close.js'
import { busMerges } from '../../nodes/close/task-merged.js'
import { GREEN } from '../../policy/policy.js'
import { greenWitnesses, runEvidence } from '../../release/evidence.js'
import { NO_PROGRESS_MS, readBoard } from '../../window/board.js'
import { sha } from './github-fake.js'

const CARD = 1700
const PR = 1701
const HEAD = sha('a')
const NEXT_HEAD = sha('b')
const COMMIT = sha('c')
const STARTED_AT = '2026-11-04T10:00:00.000Z'
const MERGED_AT = '2026-11-04T10:10:00.000Z'
const CLOSED_AT = '2026-11-04T10:30:00.000Z'
const MINUTES_TO_MERGE = 10
const MINUTES_TO_CLOSE = 30
const BOARD_READ_AT = new Date(Date.parse(CLOSED_AT) + 2 * NO_PROGRESS_MS)

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

function startedCard(): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'merged-card-end-'))
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  benches.push({ root, db })
  const line = `#${CARD} ended [implement/netwatch/S/cheap/auto] · depends — · blocks —`
  const text = `card: ${line}\nbranch: feat/${CARD}\ntouches: scripts/${CARD}/**\nwho: shift\n\ndo ${CARD}\n`
  appendEvent(db, { ts: STARTED_AT, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: line, lane: 'lane-1', depends: [], text, textSha: textSha(text) }, legacy: false })
  appendEvent(db, { ts: STARTED_AT, type: CARD_STARTED, actor: 'worker:launch:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 's1', worktree: `/trees/${CARD}`, branch: `feat/${CARD}` }, legacy: false })
  reduce(db)
  return { db, busPath }
}

function observe(bench: Bench, head: string): void {
  appendEvent(bench.db, prObserved(STARTED_AT, { pr: PR, cardId: CARD, base: 'main', head, branch: `feat/${CARD}`, mergeable: 'clean', ciFields: { ci: 'green' }, verdictOnHead: null, autoMerge: false, draft: false, bodySha: sha('d') }, null))
  reduce(bench.db)
}

function merge(bench: Bench): void {
  appendEvent(bench.db, prClosed(MERGED_AT, { pr: PR, cardId: CARD, branch: `feat/${CARD}`, merged: true, commit: COMMIT, mergedBy: 'bus', mergedAt: MERGED_AT }))
  reduce(bench.db)
}

function mergedCard(): Bench {
  const bench = startedCard()
  observe(bench, HEAD)
  merge(bench)
  return bench
}

function recordWitness(bench: Bench, head: string, verdict: string, ordinal: number): void {
  appendEvent(bench.db, { ts: STARTED_AT, type: WITNESS_RECORDED, actor: 'worker:witness:s1', cardId: CARD, pr: PR, head, dedupeKey: `${WITNESS_RECORDED}:${ordinal}`, payload: { head, base: 'base', cardBody: 'body', verdict, detail: '' }, legacy: false })
}

function closeCard(bench: Bench): number {
  appendEvent(bench.db, { ts: CLOSED_AT, type: CARD_VERIFIED, actor: 'worker:close:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_VERIFIED}:${CARD}`, payload: { verification: 'run' }, legacy: false })
  const verified = eventId(bench, CARD_VERIFIED)
  appendEvent(bench.db, { ts: CLOSED_AT, type: CARD_CLOSED, actor: 'worker:close:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${CARD}`, payload: { verification: 'run' }, legacy: false })
  reduce(bench.db)
  return verified
}

function eventId(bench: Bench, type: string): number {
  return (bench.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(type) as { id: number }).id
}

function stalled(bench: Bench): boolean {
  return readBoard({ db: bench.db, now: BOARD_READ_AT, watched: [], leaseOrders: {} }).progress.stalled
}

function verificationLine(bench: Bench): string {
  const deps: EvidenceDeps = {
    bus: bench.busPath,
    read: () => null,
    history: () => [],
    commits: () => new Set([COMMIT]),
    busMerges: () => busMerges(bench.busPath),
    verified: () => cardVerifiedClosings(bench.busPath),
    witnessed: () => greenWitnesses(bench.busPath),
    admissions: () => busIntakeAdmissions(bench.busPath),
  }
  return runEvidence(['from', 'to'], deps).stdout.find(line => line.startsWith('  result.verification: '))!
}

describe('the end of a card with a pull request is its merge', () => {
  it('a merged card with no card.closed counts in cost and has a chain proof', () => {
    const bench = mergedCard()

    expect(readBusTasks(bench.busPath)).toEqual([{ task: String(CARD), taskClass: 'implement/S', sessions: [expect.objectContaining({ id: 's1' })], minutes: MINUTES_TO_MERGE }])
    expect(cardChain(bench.db, CARD)?.proof).toBe(eventId(bench, PR_CLOSED))
  })

  it('a merged card is not in work on the board', () => {
    expect(stalled(mergedCard())).toBe(false)
  })

  it('a card with no pull request still ends at card.closed', () => {
    const bench = startedCard()
    const verified = closeCard(bench)

    expect(readBusTasks(bench.busPath).map(task => task.minutes)).toEqual([MINUTES_TO_CLOSE])
    expect(cardChain(bench.db, CARD)?.proof).toBe(verified)
    expect(stalled(bench)).toBe(false)
  })

  it('a card merged and then closed ends in cost at its merge', () => {
    const bench = mergedCard()
    closeCard(bench)

    expect(readBusTasks(bench.busPath).map(task => task.minutes)).toEqual([MINUTES_TO_MERGE])
  })

  it('a started card with no end is neither counted nor proven, and stays in work', () => {
    const bench = startedCard()

    expect(readBusTasks(bench.busPath)).toEqual([])
    expect(cardChain(bench.db, CARD)?.proof).toBeNull()
    expect(stalled(bench)).toBe(true)
  })

  it('a pull request closed unmerged is no end of the card', () => {
    const bench = startedCard()
    observe(bench, HEAD)
    appendEvent(bench.db, prClosed(MERGED_AT, { pr: PR, cardId: CARD, merged: false, commit: null, mergedBy: null, mergedAt: null }))
    reduce(bench.db)

    expect(readBusTasks(bench.busPath)).toEqual([])
    expect(cardChain(bench.db, CARD)?.proof).toBeNull()
  })
})

describe('release:evidence reads result.verification of a merged card from what the bus holds', () => {
  it('a green witness on the last head reads run, with its event as the source', () => {
    const bench = startedCard()
    observe(bench, HEAD)
    recordWitness(bench, HEAD, GREEN, 1)
    const witness = eventId(bench, WITNESS_RECORDED)
    merge(bench)

    expect(verificationLine(bench)).toBe(`  result.verification: run — ${bench.busPath} event ${witness}`)
  })

  it('no witness stays unknown and says so', () => {
    const bench = mergedCard()

    expect(verificationLine(bench)).toBe(`  result.verification: unknown — no card.verified, end line or green witness on the last head for #${CARD} in ${bench.busPath}`)
  })

  it('a red latest witness stays unknown', () => {
    const bench = startedCard()
    observe(bench, HEAD)
    recordWitness(bench, HEAD, GREEN, 1)
    recordWitness(bench, HEAD, 'red', 2)
    merge(bench)

    expect(verificationLine(bench)).toMatch(/^ {2}result\.verification: unknown — /)
  })

  it('a green witness on an earlier head stays unknown', () => {
    const bench = startedCard()
    observe(bench, HEAD)
    recordWitness(bench, HEAD, GREEN, 1)
    observe(bench, NEXT_HEAD)
    merge(bench)

    expect(verificationLine(bench)).toMatch(/^ {2}result\.verification: unknown — /)
  })

  it('a verification word on card.verified outranks the witness', () => {
    const bench = startedCard()
    observe(bench, HEAD)
    recordWitness(bench, HEAD, GREEN, 1)
    merge(bench)
    appendEvent(bench.db, { ts: CLOSED_AT, type: CARD_VERIFIED, actor: 'worker:close:s1', cardId: CARD, pr: PR, head: null, dedupeKey: `${CARD_VERIFIED}:${CARD}`, payload: { verification: 'review' }, legacy: false })

    expect(verificationLine(bench)).toBe(`  result.verification: review — ${bench.busPath} event ${eventId(bench, CARD_VERIFIED)}`)
  })
})
