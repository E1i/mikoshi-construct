import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_AGENT, QUESTION_OWNER, SHARD_ISSUED } from '../../core/events.js'
import { runInbox } from '../../core/inbox.js'
import { roundsOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { ANSWER_ON } from '../../nodes/answer/answer-worker.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function admitWith(made: MergeBench, cardId: number, touches: readonly string[], generation: string): number {
  const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: shift\n\nDo it.\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:${generation}`, payload: { card: `#${cardId}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}`, text, textSha: textSha(text), bodySha: generation }, legacy: false })
  return Number((made.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function inboxOf(made: MergeBench): string[] {
  reduce(made.db)
  const out: string[] = []
  runInbox(made.db, line => out.push(line))
  return out
}

describe('scope questions settle on the bus', () => {
  it('a session needing a file outside touches asks the bus', async () => {
    const made = bench()
    admitWith(made, 1501, ['src/a.ts'], 'body-1')
    made.tick()
    const report = '#1501 card-1501\nresult: stopped before PR\nquestion: the test needs scripts/tests/lint/policy.test.ts, outside the touches\n'
    const node = new LaunchNode({
      db: made.db,
      starter: { start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }), stop: () => {} },
      clock: made.clock.now,
      session: 'node-1',
      mode: 'live',
      env: {},
      processes: { commandLine: () => null, signalGroup: () => {} },
      resulted: () => true,
      reportOf: () => report,
      isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    })
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    made.tick()

    expect(node.stopOverdue()).toEqual([1501])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: QUESTION_AGENT, widen: ['scripts/tests/lint/policy.test.ts'] })])
    made.tick()
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ need: 'command', card: 1501, text: expect.stringContaining('card #1501 asks to widen its touches') })])
  })

  it('an amend wakes the answer worker', () => {
    expect(ANSWER_ON).toContain(CARD_ADMITTED)
  })

  it('a touches amend on an open PR spends no round', () => {
    const first = 'a'.repeat(40)
    const fixed = 'b'.repeat(40)
    const reviews = [
      { head: first, verdict: 'changes', card_body: 'body-1' },
      { head: first, verdict: 'changes', card_body: 'body-2' },
      { head: fixed, verdict: 'changes', card_body: 'body-2' },
    ]
    expect(roundsOf(reviews, new Set(['body-2']))).toBe(1)
    expect(roundsOf(reviews, new Set())).toBe(2)
  })

  it('under a shard a window amend widening touches to the stopped paths clears the scope stop', () => {
    const stopOf = (made: MergeBench, cardId: number): void => {
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:answer:s1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: QUESTION_OWNER, detail: `scripts/tests/morse/cli.test.ts for #${cardId}`, widen: ['scripts/tests/morse/cli.test.ts'] }, legacy: false })
    }
    const shardOf = (made: MergeBench, cardId: number): void => {
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${cardId}`, payload: { id: `shard-${cardId}`, under: null }, legacy: false })
    }
    const question = (cardId: number): string => `[bus:inbox] card.stopped question.owner · card #${cardId} · scripts/tests/morse/cli.test.ts for #${cardId}`

    const widened = bench()
    admitWith(widened, 1502, ['src/a.ts'], 'body-1')
    shardOf(widened, 1502)
    stopOf(widened, 1502)
    expect(inboxOf(widened)).toEqual([question(1502)])
    admitWith(widened, 1502, ['src/a.ts', 'scripts/tests/morse/cli.test.ts'], 'body-2')
    expect(inboxOf(widened)).toEqual(['[bus:inbox] the owner inbox is empty'])

    const noShard = bench()
    admitWith(noShard, 1503, ['src/a.ts'], 'body-1')
    stopOf(noShard, 1503)
    admitWith(noShard, 1503, ['src/a.ts', 'scripts/tests/morse/cli.test.ts'], 'body-2')
    expect(inboxOf(noShard)).toEqual([question(1503)])

    const elsewhere = bench()
    admitWith(elsewhere, 1504, ['src/a.ts'], 'body-1')
    shardOf(elsewhere, 1504)
    stopOf(elsewhere, 1504)
    admitWith(elsewhere, 1504, ['src/a.ts', 'src/b.ts'], 'body-2')
    expect(inboxOf(elsewhere)).toEqual([question(1504)])
  })
})
