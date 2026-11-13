import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_STARTED, CARD_VERIFIED } from '../../core/events.js'
import { keyOf } from '../../core/queue.js'
import { CloseNode } from '../../nodes/close/close-worker.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { mergeBench } from './merge-bench.js'

interface Bench extends MergeBench {
  root: string
}

const CARD = 1845
const benches: Bench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0)) {
    made.close()
    rmSync(made.root, { recursive: true, force: true })
  }
})

function bench(): Bench {
  const made = { ...mergeBench(), root: mkdtempSync(path.join(tmpdir(), 'bus-readmitted-close-')) }
  benches.push(made)
  return made
}

function admitted(made: Bench, round: number): string {
  const text = `card: #${CARD} card-${CARD} [probe/netwatch/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nRound ${round}.\n`
  const bodySha = textSha(text)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${round}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: bodySha, bodySha }, legacy: false })
  return bodySha
}

function started(made: Bench, round: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:${round}`, payload: { session: `s${round}` }, legacy: false })
}

function verifiedByReport(made: Bench, label: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_VERIFIED}:${CARD}:${label}`, payload: { path: 'cheap', verification: 'run', report: `/shift/report-${label}.md` }, legacy: false })
}

async function closePasses(made: Bench, passes = 2): Promise<void> {
  const node = new CloseNode({ silentMs: SILENT_MS, db: made.db, reported: () => 'run', clock: made.clock.now, session: 'node-1', parking: path.join(made.root, 'parking'), mode: 'live', env: {}, trees: { remove: () => null } })
  for (let pass = 0; pass < passes; pass += 1) {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    made.tick()
  }
}

function cardState(made: Bench): string | null {
  return (made.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD) as { state: string } | undefined)?.state ?? null
}

function closings(made: Bench): number {
  return Number((made.db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND card_id = ?').get(CARD_CLOSED, CARD) as { n: number }).n)
}

function closeTasks(made: Bench): { task_key: string, state: string }[] {
  return made.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'close' AND card_id = ? ORDER BY event_id`).all(CARD) as unknown as { task_key: string, state: string }[]
}

describe('a re-admitted card closes again', () => {
  it('a card closed, admitted again and verified by report ends closed', async () => {
    const made = bench()
    admitted(made, 1)
    started(made, 1)
    verifiedByReport(made, 'first')
    made.tick()
    await closePasses(made)
    expect(cardState(made)).toBe('closed')
    expect(closings(made)).toBe(1)

    const secondBody = admitted(made, 2)
    started(made, 2)
    made.tick()
    expect(cardState(made)).toBe('running')
    verifiedByReport(made, 'second')
    verifiedByReport(made, 'second-again')
    made.tick()
    await closePasses(made)

    expect(cardState(made)).toBe('closed')
    expect(closings(made)).toBe(2)
    expect(closeTasks(made)).toEqual([
      { task_key: keyOf({ queue: 'close', cardId: CARD }), state: 'completed' },
      { task_key: keyOf({ queue: 'close', cardId: CARD, cardBody: secondBody }), state: 'completed' },
    ])

    await closePasses(made)
    expect(closings(made)).toBe(2)
  })

  it('a card verified once is closed once', async () => {
    const made = bench()
    admitted(made, 1)
    started(made, 1)
    verifiedByReport(made, 'only')
    made.tick()

    await closePasses(made, 3)

    expect(cardState(made)).toBe('closed')
    expect(closings(made)).toBe(1)
    expect(closeTasks(made)).toEqual([{ task_key: keyOf({ queue: 'close', cardId: CARD }), state: 'completed' }])
  })
})

describe('a card body sha outside its queues', () => {
  it('names the refused queue after a colon and a space', () => {
    expect(() => keyOf({ queue: 'review', cardId: CARD, cardBody: 'ec61c8323d8b' })).toThrow('or a witness or a close task: review, ec61c8323d8b')
  })
})
