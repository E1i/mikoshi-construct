import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, REVIEW_RECORDED, TASK_LEASED } from '../../core/events.js'
import { coverageLines, expectedMinutes, NOT_ENOUGH_DATA, OVER_TIME, RoundOverTime, roundSamples, shapeOf } from '../../supervisor/expected-time.js'
import { StalledSessions } from '../../supervisor/stalled-sessions.js'
import { mergeBench } from '../bus/merge-bench.js'

const UNMEASURED = 1951
const MEASURED = 1952
const ACTION = 'now: Bash pnpm test, running for 4 min'
const MINUTE_MS = 60_000
const RUN_MINUTES = 60

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function body(card: number, shape: string): string {
  return `card: #${card} timed [implement/construct/${shape}/owner] · depends — · blocks —\n\nA timed round.\n`
}

function admitted(bench: MergeBench, card: number, shape: string): void {
  const text = body(card, shape)
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:timed-${card}`, payload: { lane: 'lane-a', decision: 'auto', contour: shape.split('/')[1], depends: [], admission: `timed-${card}`, text, textSha: textSha(text) }, legacy: false })
}

function answered(bench: MergeBench, card: number, minutes: number, index: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ANSWERED, actor: 'worker:answer:node-1', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ANSWERED}:timed-${card}-${index}`, payload: { minutes, session: `s-${index}` }, legacy: false })
}

function leased(bench: MergeBench, card: number): string {
  const taskKey = `answer:${card}:timed`
  const id = Number(bench.db.prepare('INSERT INTO events (ts, type, actor, card_id, pr, head, dedupe_key, legacy, payload) VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, ?)').run(bench.clock.now().toISOString(), TASK_LEASED, 'worker:answer:node-1', card, `${TASK_LEASED}:${taskKey}:1`, JSON.stringify({ task_key: taskKey, queue: 'answer', lease_gen: 1 })).lastInsertRowid)
  bench.db.prepare(`INSERT INTO tasks (task_key, queue, card_id, pr, head, state, lease_gen, event_id) VALUES (?, 'answer', ?, NULL, NULL, 'leased', 1, ?)`).run(taskKey, card, id)
  return taskKey
}

function alarms(bench: MergeBench): { card_id: number, payload: Record<string, unknown> }[] {
  return (bench.db.prepare('SELECT card_id, payload FROM events WHERE type = ? ORDER BY id').all(BOARD_ALARM) as { card_id: number, payload: string }[]).map(row => ({ card_id: row.card_id, payload: JSON.parse(row.payload) as Record<string, unknown> }))
}

function room(): { bench: MergeBench, later: () => Date } {
  const bench = mergeBench()
  benches.push(bench)
  admitted(bench, UNMEASURED, 'S/cheap')
  admitted(bench, MEASURED, 'M/ladder')
  bench.tick()
  for (const [index, minutes] of [12, 18, 20].entries())
    answered(bench, MEASURED, minutes, index)
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:node-1', cardId: MEASURED, pr: 7, head: 'a'.repeat(40), dedupeKey: `${REVIEW_RECORDED}:timed`, payload: { verdict: 'pass', review_ms: 6 * MINUTE_MS }, legacy: true })
  leased(bench, UNMEASURED)
  leased(bench, MEASURED)
  const start = bench.clock.now().getTime()
  return { bench, later: () => new Date(start + RUN_MINUTES * MINUTE_MS) }
}

describe('expected round time from the bus measurements', () => {
  it('reads size and contour from the card line', () => {
    expect(shapeOf(body(1, 'L/cheap').split('\n')[0]!)).toEqual({ size: 'L', contour: 'cheap' })
    expect(shapeOf(null)).toEqual({ size: '?', contour: '?' })
  })

  it('shows the coverage by size and contour before any expected time', () => {
    const { bench } = room()
    const samples = roundSamples(bench.db)
    expect(expectedMinutes(samples, 'answer', { size: 'M', contour: 'ladder' })).toBe(20)
    expect(expectedMinutes(samples, 'answer', { size: 'S', contour: 'cheap' })).toBeNull()
    expect(coverageLines(samples)).toEqual(['answer M/ladder: 3 samples · expected within 20 min'])
    expect(coverageLines([])).toEqual([expect.stringContaining(NOT_ENOUGH_DATA)])
  })

  it('no sample gives not enough data and no alarm while a measured overrun raises over_time and the session runs on', () => {
    const { bench, later } = room()
    const asked: (string | null)[] = []
    const overTime = new RoundOverTime(bench.db, later, (_card, session) => {
      asked.push(session)
      return ACTION
    })
    const stopped: string[] = []
    const sessions = new StalledSessions(bench.db, later, { lifeOf: () => 'live', overTime, stop: session => stopped.push(session), spendOf: () => null, pulseOf: () => null })

    const readings = overTime.readings()
    expect(readings.find(reading => reading.card === UNMEASURED)?.line).toContain(`${NOT_ENOUGH_DATA} for S/cheap (0 rounds measured), so no expected time and no warning`)
    expect(readings.find(reading => reading.card === MEASURED)?.line).toContain(`has run ${RUN_MINUTES} min past its expected 20 min for M/ladder`)

    const lines = sessions.step()

    expect(lines.filter(line => line.includes(OVER_TIME))).toEqual([expect.stringContaining(ACTION)])
    expect(alarms(bench)).toEqual([{ card_id: MEASURED, payload: expect.objectContaining({ reason: OVER_TIME, task_key: `answer:${MEASURED}:timed`, detail: expect.stringContaining(`the session runs on and is not stopped; ${ACTION}`) }) }])
    expect(stopped).toEqual([])
    expect(bench.db.prepare(`SELECT card_id, state FROM tasks WHERE queue = 'answer' ORDER BY card_id`).all()).toEqual([{ card_id: UNMEASURED, state: 'leased' }, { card_id: MEASURED, state: 'leased' }])
    expect(overTime.check()).toEqual([])
    expect(alarms(bench)).toHaveLength(1)
  })
})
