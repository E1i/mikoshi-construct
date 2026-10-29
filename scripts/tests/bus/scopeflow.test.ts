import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { pathsOutside } from '../../../src/card/covering-tests.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_SESSION_ENDED, CARD_STOPPED, OWNER_WAIT_OPENED, PR_OPENED, QUESTION_AGENT, QUESTION_OWNER, SHARD_ISSUED } from '../../core/events.js'
import { runInbox } from '../../core/inbox.js'
import { roundsOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { scopeWideningAsked } from '../../nodes/answer/answer-executor.js'
import { ANSWER_ON } from '../../nodes/answer/answer-worker.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { cardDecisionCommand, DECISIONS_SCOPE } from '../../policy/shards.js'
import { shardDecisions } from '../../window/board.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
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

function admitWith(made: MergeBench, cardId: number, touches: readonly string[], generation: string, creates: readonly string[] = []): number {
  const createsLine = creates.length === 0 ? '' : `creates: ${creates.join(', ')}\n`
  const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: ${touches.join(', ')}\n${createsLine}continue: stop\nwho: shift\n\nDo it.\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:${generation}`, payload: { card: `#${cardId}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}`, text, textSha: textSha(text), bodySha: generation }, legacy: false })
  return Number((made.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function inboxOf(made: MergeBench): string[] {
  reduce(made.db)
  const out: string[] = []
  runInbox(made.db, line => out.push(line))
  return out
}

function issueWindowShard(made: MergeBench): void {
  const now = made.clock.now()
  appendEvent(made.db, { ts: now.toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'Eli', scope: DECISIONS_SCOPE, until: new Date(now.getTime() + 3_600_000).toISOString(), window: 1 }, legacy: false })
}

function ownerStop(made: MergeBench, cardId: number, detail: string): string {
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:answer:s1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: QUESTION_OWNER, detail }, legacy: false })
  const wait = openBusWait(made.db, ts, 'worker:answer:s1', { need: 'decision', text: `card #${cardId} asks: ${detail}`, command: cardDecisionCommand(cardId), card: cardId })
  reduce(made.db)
  return wait
}

function windowCloses(made: MergeBench, wait: string, answer: string): string {
  const refuse = (): never => {
    throw new Error('not this request')
  }
  requestFromWindow(made.db, made.clock.now().toISOString(), 'test', { kind: 'owner.wait.close', id: wait, answer })
  const [outcome] = new WindowRequests(made.db, made.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }).run()
  return outcome!.kind
}

function endedSession(made: MergeBench, cardId: number, committed: boolean, publish: () => void): LaunchNode {
  return new LaunchNode({
    db: made.db,
    starter: { start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }), stop: () => {} },
    clock: made.clock.now,
    session: 'node-1',
    mode: 'live',
    env: {},
    processes: { commandLine: () => null, signalGroup: () => {} },
    resulted: () => true,
    warned: () => false,
    committed: () => committed,
    publish,
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
  })
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
    const detailOf = (cardId: number): string => `scripts/tests/morse/cli.test.ts is outside the touches of #${cardId}`
    const stopOf = (made: MergeBench, cardId: number, underAShard: boolean): void => {
      const widen = scopeWideningAsked(detailOf(cardId), { admission: 1, touches: ['src/a.ts'], creates: [] }, underAShard)
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:answer:s1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: QUESTION_OWNER, detail: detailOf(cardId), ...(widen.length === 0 ? {} : { widen }) }, legacy: false })
    }
    const question = (cardId: number): string => `[bus:inbox] card.stopped question.owner · card #${cardId} · ${detailOf(cardId)}`

    const widened = bench()
    admitWith(widened, 1502, ['src/a.ts'], 'body-1')
    stopOf(widened, 1502, true)
    expect(inboxOf(widened)).toEqual([question(1502)])
    admitWith(widened, 1502, ['src/a.ts', 'scripts/tests/morse/cli.test.ts'], 'body-2')
    expect(inboxOf(widened)).toEqual(['[bus:inbox] the owner inbox is empty'])

    const noShard = bench()
    admitWith(noShard, 1503, ['src/a.ts'], 'body-1')
    stopOf(noShard, 1503, false)
    admitWith(noShard, 1503, ['src/a.ts', 'scripts/tests/morse/cli.test.ts'], 'body-2')
    expect(inboxOf(noShard)).toEqual([question(1503)])

    const elsewhere = bench()
    admitWith(elsewhere, 1504, ['src/a.ts'], 'body-1')
    stopOf(elsewhere, 1504, true)
    admitWith(elsewhere, 1504, ['src/a.ts', 'src/b.ts'], 'body-2')
    expect(inboxOf(elsewhere)).toEqual([question(1504)])
  })

  it('the inbox counts a stopped path covered by a touches glob or a creates entry as the answer executor does', () => {
    const wanted = ['scripts/tests/morse/cli.test.ts']
    const amends: Record<number, { touches: string[], creates: string[], clears: boolean }> = {
      1505: { touches: ['src/a.ts', 'scripts/tests/morse/**'], creates: [], clears: true },
      1506: { touches: ['src/a.ts'], creates: ['scripts/tests/morse/cli.test.ts (plain)'], clears: true },
      1507: { touches: ['src/a.ts'], creates: ['scripts/tests/morse/cli.test.ts'], clears: true },
      1508: { touches: ['src/a.ts', 'scripts/tests/mo/**'], creates: ['scripts/tests/morse/cli.test.tsx'], clears: false },
    }
    for (const [card, amend] of Object.entries(amends)) {
      const cardId = Number(card)
      const made = bench()
      admitWith(made, cardId, ['src/a.ts'], 'body-1')
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:answer:s1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: QUESTION_OWNER, detail: 'outside the touches', widen: wanted }, legacy: false })
      admitWith(made, cardId, amend.touches, 'body-2', amend.creates)
      expect(pathsOutside(amend.touches, amend.creates, wanted).length === 0).toBe(amend.clears)
      expect(inboxOf(made).includes('[bus:inbox] the owner inbox is empty')).toBe(amend.clears)
    }
  })

  it('an owner question carries a widening only when it asks about the scope under a shard', () => {
    const scope = { admission: 1, touches: ['src/a.ts'], creates: [] }
    expect(scopeWideningAsked('may I change the retry policy the way src/b.ts does?', scope, true)).toEqual([])
    expect(scopeWideningAsked('the fix needs src/b.ts, outside the touches', scope, true)).toEqual(['src/b.ts'])
    expect(scopeWideningAsked('the fix needs src/b.ts, outside the touches', scope, false)).toEqual([])
    expect(scopeWideningAsked('the fix needs src/b.ts, outside the touches', null, true)).toEqual([])
  })

  it('under a shard the window answer lifts a question.owner stop and the board shows it as a shard decision', () => {
    const made = bench()
    admitWith(made, 1510, ['src/a.ts'], 'body-1')
    issueWindowShard(made)
    const wait = ownerStop(made, 1510, 'may the retry back off the way src/b.ts does?')
    expect(inboxOf(made)).toHaveLength(1)

    expect(windowCloses(made, wait, 'yes, back off as src/b.ts does')).toBe('done')
    expect(inboxOf(made)).toEqual(['[bus:inbox] the owner inbox is empty'])
    expect(shardDecisions(made.db)).toEqual([expect.objectContaining({ card: 1510, shard: 'ws-1', wait, answer: 'yes, back off as src/b.ts does' })])

    const noShard = bench()
    admitWith(noShard, 1511, ['src/a.ts'], 'body-1')
    const closedOnly = ownerStop(noShard, 1511, 'may the retry back off the way src/b.ts does?')
    expect(windowCloses(noShard, closedOnly, 'yes')).toBe('done')
    expect(inboxOf(noShard)).toHaveLength(1)
    expect(shardDecisions(noShard.db)).toEqual([])
  })

  it('a question.owner stop on a listed owner path is not lifted by the window', () => {
    const reserved = [
      'may I add a row to architecture/security-invariants.md?',
      'may I edit .claude/agents/implementer.md?',
      'may I change architecture/owner-merges.md?',
      'may the version pull request go out?',
      'may I publish to npm?',
      'may I edit .github/workflows/release.yml?',
      'may I drop the third witness, it cannot fail on base?',
    ]
    for (const [at, detail] of reserved.entries()) {
      const made = bench()
      const cardId = 1520 + at
      admitWith(made, cardId, ['src/a.ts'], 'body-1')
      issueWindowShard(made)
      const wait = ownerStop(made, cardId, detail)
      expect(windowCloses(made, wait, 'yes')).toBe('refused')
      expect(inboxOf(made)).toHaveLength(1)
      expect(shardDecisions(made.db)).toEqual([])
    }
  })

  it('a session that ended without a PR gets its PR from the bus', async () => {
    const run = async (cardId: number, committed: boolean, opens: boolean): Promise<{ made: MergeBench, node: LaunchNode, published: number[] }> => {
      const made = bench()
      admitWith(made, cardId, ['src/a.ts'], 'body-1')
      made.tick()
      const published: number[] = []
      const node = endedSession(made, cardId, committed, () => {
        published.push(cardId)
        if (opens)
          appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId, pr: 990, head: null, dedupeKey: `${PR_OPENED}:${cardId}:990`, payload: { pr: 990 }, legacy: false })
      })
      const controller = new AbortController()
      await node.run({ pause: async () => controller.abort(), signal: controller.signal })
      made.tick()
      return { made, node, published }
    }

    const opened = await run(1530, true, true)
    expect(opened.node.stopOverdue()).toEqual([])
    expect(opened.published).toEqual([1530])
    expect(eventsOf(opened.made.db, CARD_SESSION_ENDED)).toEqual([expect.objectContaining({ published: true, stopped: false })])

    const refused = await run(1531, true, false)
    expect(refused.node.stopOverdue()).toEqual([1531])
    expect(eventsOf(refused.made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'fault', detail: expect.stringContaining('the bus ran tree-pr over the commit in /trees/mc-1531 and it opened no pull request') })])

    const empty = await run(1532, false, true)
    expect(empty.node.stopOverdue()).toEqual([1532])
    expect(empty.published).toEqual([])
  })
})
