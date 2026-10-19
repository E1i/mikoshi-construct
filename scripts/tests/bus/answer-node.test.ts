import type { AnswerOutcome } from '../../bus/answer-executor.js'
import type { AnswerNodeParts, AnswerRun, AnswerStep } from '../../bus/answer-worker.js'
import type { Answerer } from '../../bus/answerer.js'
import type { CardTreeTools } from '../../bus/card-tree.js'
import type { Lease } from '../../bus/lease.js'
import type { DetectionMode, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { Isolation, IsolationReader } from '../../ghosts/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerExecutor } from '../../bus/answer-executor.js'
import { AnswerNode, answerNodeOf } from '../../bus/answer-worker.js'
import { answerPrompt, tokensOf } from '../../bus/answerer.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED } from '../../bus/inbox.js'
import { failTask, leaseNext } from '../../bus/lease.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { answerCandidates, FAILURES_TO_STOP, keyOf, queueTask, TASK_ENQUEUED } from '../../bus/queue.js'
import { DECISIONS_SCOPE, OWNERS_UNDER_ANY_SHARD, SHARD_DECIDED, SHARD_ISSUED, VERSION_PR_RESERVATION } from '../../bus/shards.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const benches: MergeBench[] = []
const roots: string[] = []
const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
const OWNER_QUESTION = 'may the card also touch architecture/owner-merges.md?'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class ProbedAnswerNode extends AnswerNode {
  failOnCall: number | null = null
  private calls = 0

  found(scope?: Scope): string[] {
    return this.candidates(scope).map(keyOf)
  }

  protected override candidates(scope?: Scope): QueuedTask[] {
    this.calls += 1
    if (this.calls === this.failOnCall)
      throw new Error('injected in the middle of a batch')
    return super.candidates(scope)
  }

  protected override async handle(lease: Lease): Promise<AnswerStep> {
    return { kind: 'fenced', taskKey: lease.taskKey }
  }

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow'): ProbedAnswerNode {
  const parts: AnswerNodeParts = { db: made.db, answerer: async () => {
    throw new Error('the probe answers nothing')
  }, ownerMerges: () => '', clock: made.clock.now, session: 'node-1', cardText: () => null, mode, env: {} }
  return new ProbedAnswerNode(parts)
}

async function once(node: AnswerNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function prKey(pr: number, head = sha('a')): string {
  return keyOf({ queue: 'answer', cardId: pr + 100, pr, head })
}

function questionKey(cardId: number, stop: number): string {
  return keyOf({ queue: 'answer', cardId, stop })
}

function stopped(made: MergeBench, cardId: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}:${made.clock.now().getTime()}`, payload: { reason: 'question.agent', detail: `a question on card #${cardId}` }, legacy: false })
  return lastEventOf(made, CARD_STOPPED)
}

function answered(made: MergeBench, cardId: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ANSWERED, actor: 'worker:answer:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_ANSWERED}:${cardId}`, payload: { session: 's', resumed: true, source: 'question', from: sha('a'), to: sha('e') }, legacy: false })
  return lastEventOf(made, CARD_ANSWERED)
}

function lastEventOf(made: MergeBench, type: string, pr?: number): number {
  const row = made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ? AND (? IS NULL OR pr = ?)').get(type, pr ?? null, pr ?? null) as { id: number | null }
  return Number(row.id)
}

function detected(made: MergeBench, via: 'event' | 'tick'): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(each => each.via === via)
}

function keysOf(made: MergeBench, via: 'event' | 'tick'): string[] {
  return detected(made, via).map(each => String(each.key)).sort()
}

function derivedKeys(made: MergeBench): string[] {
  return answerCandidates(made.db, made.clock.now().toISOString()).map(keyOf)
}

function answerTasks(made: MergeBench, cardId: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'answer' AND card_id = ?`).get(cardId) as { n: number }).n)
}

function enqueuedOf(made: MergeBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function cursorOf(made: MergeBench): number {
  return Number((made.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'answer'`).get() as { event_id: number }).event_id)
}

function openEach(made: MergeBench, base: number): string[] {
  made.gitHub.open({ number: base, review: 'failure' })
  made.gitHub.open({ number: base + 1, required: 'failure', failed: ['lint'] })
  made.gitHub.open({ number: base + 2, mergeable_state: 'dirty' })
  made.tick()
  return [prKey(base), prKey(base + 1), prKey(base + 2)]
}

interface ShardIssue {
  scope: string
  untilMs: number
}

const LIVE_DECISIONS: ShardIssue = { scope: DECISIONS_SCOPE, untilMs: 3_600_000 }
const PARTIAL: IsolationReader = () => ({ level: 'partial', mechanism: 'claude-code-sandbox', gaps: [] })

function questionUnderShard(made: MergeBench, now: Date, shard: ShardIssue | null): { trees: string, lease: () => Lease } {
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-shard-'))
  roots.push(trees)
  const worktree = path.join(trees, 'mc-905')
  mkdirSync(worktree)
  const ts = now.toISOString()
  if (shard !== null)
    appendEvent(made.db, { ts, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'Eli', scope: shard.scope, until: new Date(now.getTime() + shard.untilMs).toISOString(), window: 1 }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STARTED}:905`, payload: { session: 'card-session-1', worktree, branch: 'feat/card-905', base: sha('1') }, legacy: false })
  const stop = stopped(made, 905)
  queueTask(made.db, ts, { queue: 'answer', cardId: 905, stop })
  return { trees, lease: () => leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')! }
}

function askingAnswerer(question: string): Answerer {
  return async () => ({ session: 'card-session-1', resumed: true, before: sha('a'), after: sha('a'), owner: question })
}

async function askedUnderShard(made: MergeBench, question: string, isolation?: IsolationReader, shard: ShardIssue | null = LIVE_DECISIONS): Promise<AnswerOutcome> {
  const { trees, lease } = questionUnderShard(made, made.clock.now(), shard)
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db: made.db, answerer: askingAnswerer(question), ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees, isolation })
  return executor.answer(lease())
}

const KEPT_BY_THE_OWNER: Record<string, string[]> = {
  [VERSION_PR_RESERVATION]: ['may the version pull request merge?', 'is changeset-release/main ready?', 'merge chore: version packages?'],
  'npm-stage': ['approve the npm stage?'],
  'security-invariants': ['may it edit security-invariants?'],
}

describe('the answer node', () => {
  it('a question stop, a changes verdict, a red CI and a dirty pull request are each detected by their event and by a tick', async () => {
    const made = bench()
    const first = [...openEach(made, 990), questionKey(905, stopped(made, 905))]
    const node = nodeOf(made)
    await once(node)
    expect(keysOf(made, 'tick')).toEqual([...first].sort())
    expect(detected(made, 'event')).toEqual([])

    const second = [...openEach(made, 994), questionKey(906, stopped(made, 906))]
    await once(node)
    expect(keysOf(made, 'event')).toEqual([...first, ...second].sort())

    const third = stopped(made, 907)
    await once(node)
    expect(detected(made, 'event').find(each => each.key === questionKey(907, third))).toEqual({ key: questionKey(907, third), via: 'event', event_id: third })
  })

  it('a card.answered after a question stop takes the card out of the candidates, scoped by its card', async () => {
    const made = bench()
    const asked = stopped(made, 905)
    const other = stopped(made, 906)
    const node = nodeOf(made)
    await once(node)
    expect(node.found({ cardId: 905 })).toEqual([questionKey(905, asked)])

    answered(made, 905)
    expect(node.found()).toEqual([questionKey(906, other)])
    expect(node.found({ cardId: 905 })).toEqual([])
    expect(node.found({ cardId: 906 })).toEqual([questionKey(906, other)])

    const later = stopped(made, 907)
    await once(node)
    expect(detected(made, 'event')).toEqual([{ key: questionKey(907, later), via: 'event', event_id: later }])
  })

  it('the node and answerCandidates find one set on one snapshot, and shadow records node.equivalence with nothing on one side only', async () => {
    const made = bench()
    const fromPrs = openEach(made, 990)
    made.gitHub.open({ number: 997, review: 'failure' })
    made.tick()
    made.gitHub.close(997, false)
    made.tick()
    const question = questionKey(905, stopped(made, 905))
    const node = nodeOf(made)
    const keys = [...new Set(derivedKeys(made))].sort()

    expect(keys).toEqual(expect.arrayContaining([...fromPrs, question]))
    expect(keys).not.toContain(prKey(997))
    expect(node.found()).toEqual(derivedKeys(made))
    expect(node.found({ pr: 991 })).toEqual([prKey(991)])

    const enqueued = keys.map(key => enqueuedOf(made, key))
    await once(node)
    expect(eventsOf(made.db, NODE_EQUIVALENCE)).toEqual([{ same: keys, only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(keys.map(key => enqueuedOf(made, key))).toEqual(enqueued)
  })

  it('i1: in live mode the node and deriveQueues detect one key, and there is one task row and one task.enqueued', async () => {
    const made = bench()
    const node = nodeOf(made, 'live')
    await once(node)
    expect(answerTasks(made, 905)).toBe(0)

    const key = questionKey(905, stopped(made, 905))
    await once(node)
    expect(enqueuedOf(made, key)).toBe(1)
    made.tick()
    await once(node)
    made.tick()

    expect(answerTasks(made, 905)).toBe(1)
    expect(enqueuedOf(made, key)).toBe(1)
  })

  it('i2: a failure in the middle of a batch rolls back the cursor with its records, and the restart detects each candidate once', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)
    const cursor = cursorOf(made)

    const first = stopped(made, 905)
    const second = stopped(made, 906)
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    expect(detected(made, 'event')).toEqual([])
    expect(cursorOf(made)).toBe(cursor)

    await once(node)
    await once(node)
    expect(detected(made, 'event')).toEqual([{ key: questionKey(905, first), via: 'event', event_id: first }, { key: questionKey(906, second), via: 'event', event_id: second }])
  })

  it('i3: a cursor reset to 0 gives no second detection and no second task', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const made = bench()
      const node = nodeOf(made, mode)
      await once(node)
      const [key] = openEach(made, 990)
      await once(node)
      await once(node)
      made.tick()
      const counts = (): object => ({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, key!), tasks: answerTasks(made, 1090) })
      const before = counts()
      expect(enqueuedOf(made, key!), mode).toBe(1)

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect(counts(), mode).toEqual(before)
    }
  })

  it('a question under a decisions shard is recorded as decided under shard and work does not stop', async () => {
    const made = bench()
    const outcome = await askedUnderShard(made, OWNER_QUESTION, PARTIAL)
    expect(outcome).toEqual({ kind: 'decided', taskKey: expect.any(String) as unknown, shard: 'ws-1', question: OWNER_QUESTION })
    expect(eventsOf(made.db, SHARD_DECIDED)).toEqual([{ shard: 'ws-1', question: OWNER_QUESTION, ground: expect.stringContaining('partial isolation') as unknown, options: expect.any(Array) as unknown }])
    expect(eventsOf(made.db, CARD_STOPPED).map(each => each.reason)).toEqual(['question.agent'])
  })

  it('card.answered carries the minutes and tokens of the answer session', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const answerer: Answerer = async () => {
      made.clock.advance(7.5 * 60_000)
      return { session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null, tokens: 48_200 }
    }
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees })
    expect(await executor.answer(lease())).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(eventsOf(made.db, CARD_ANSWERED)).toEqual([{ session: 'card-session-1', resumed: true, source: 'question', from: sha('a'), to: sha('e'), minutes: 7.5, tokens: 48_200 }])
  })

  it('card.answered carries no measurement from an answerer that reports no usage', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const answerer: Answerer = async () => ({ session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null })
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees })
    expect(await executor.answer(lease())).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(eventsOf(made.db, CARD_ANSWERED)).toEqual([{ session: 'card-session-1', resumed: true, source: 'question', from: sha('a'), to: sha('e') }])
  })

  it('the answer round prompt names the window gate of D-194, not pnpm run quality', () => {
    const prompt = answerPrompt({
      lease: { taskKey: 'answer:1079:925:head', queue: 'answer', cardId: 1079, pr: 925, head: sha('a'), leaseGen: 1, actor: 'worker:answer:s' },
      source: { kind: 'changes', findings: ['a.ts:1 a finding'], events: [] },
      widened: null,
      card: { session: 's', worktree: '/trees/mc-1079', branch: 'feat/window-gate-by-layers' },
    }, '/answers/s.1.owner.txt', null)

    expect(prompt).toContain('D-194')
    expect(prompt).toContain('pnpm gate:window')
    expect(prompt).toContain('pnpm typecheck')
    expect(prompt).toContain('pnpm lint')
    expect(prompt).not.toContain('pnpm run quality')
  })

  it('tokensOf sums the input, output and cache counts of a result usage and is null without one', () => {
    expect(tokensOf({ input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 45_000 })).toBe(48_210)
    expect(tokensOf({ output_tokens: 5 })).toBe(5)
    expect(tokensOf({})).toBeNull()
    expect(tokensOf(null)).toBeNull()
  })

  it('a decisions shard is refused without isolation', async () => {
    for (const isolation of [undefined, (): Isolation => ({ level: 'none', why: 'no sandbox' })]) {
      const made = bench()
      const outcome = await askedUnderShard(made, OWNER_QUESTION, isolation)
      expect(outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: expect.stringContaining(`the ${DECISIONS_SCOPE} shard ws-1 is refused without isolation`) as unknown })
      expect(eventsOf(made.db, SHARD_DECIDED)).toEqual([])
    }
  })

  it('an owner question without a live decisions shard stops for the owner: no shard, an expired one, a merge-scope one', async () => {
    for (const shard of [null, { scope: DECISIONS_SCOPE, untilMs: -1 }, { scope: 'merge', untilMs: 3_600_000 }]) {
      const made = bench()
      expect(await askedUnderShard(made, OWNER_QUESTION, PARTIAL, shard)).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: OWNER_QUESTION })
      expect(eventsOf(made.db, SHARD_DECIDED)).toEqual([])
    }
  })

  it('a reserved card question stays the owner\'s under a decisions shard', async () => {
    const made = bench()
    const question = `${OWNER_QUESTION} #905 reserved`
    expect(await askedUnderShard(made, question, PARTIAL)).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: question })
    expect(eventsOf(made.db, SHARD_DECIDED)).toEqual([])
  })

  it('the version pull request, the npm stage and security-invariants stay the owner\'s under any shard', async () => {
    expect(Object.keys(KEPT_BY_THE_OWNER).sort()).toEqual(Object.keys(OWNERS_UNDER_ANY_SHARD).sort())
    for (const [reservation, asks] of Object.entries(KEPT_BY_THE_OWNER)) {
      for (const ask of asks) {
        const made = bench()
        const question = `${OWNER_QUESTION} ${ask}`
        expect(await askedUnderShard(made, question, PARTIAL)).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: `${question} (${reservation} stays the owner's under any shard)` })
        expect(eventsOf(made.db, SHARD_DECIDED)).toEqual([])
      }
    }
  })

  it('the answer worker hands its isolation reader to the node and logs the question it decided under the shard', async () => {
    const made = bench()
    vi.useFakeTimers({ toFake: ['Date'], now: made.clock.now() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    questionUnderShard(made, made.clock.now(), LIVE_DECISIONS)
    const isolation = vi.fn(PARTIAL)
    const run: AnswerRun = { busPath: ':memory:', answerer: askingAnswerer(OWNER_QUESTION), ownerMerges: () => OWNER_MERGES, cardText: () => null, session: 'worker-1', pause: async () => {}, isolation }
    await once(answerNodeOf(run, made.db, 'shadow'))
    expect(isolation).toHaveBeenCalled()
    expect(eventsOf(made.db, SHARD_DECIDED)).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`decided under shard ws-1, the card goes on: ${OWNER_QUESTION}`))
  })

  it('an answer stopped on no card tree is requeued and a task of an old head is superseded by deriveQueues beside the node as before', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    made.gitHub.open({ number: 1014, review: 'failure' })
    made.tick()
    for (let failure = 0; failure < FAILURES_TO_STOP; failure++)
      failTask(made.db, made.clock.now().toISOString(), leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:probe')!, { reason: 'no_card_tree', withdraw: false })
    expect(taskState(made.db, prKey(1014)).state).toBe('stopped')
    await once(node)
    made.tick()
    expect(taskState(made.db, prKey(1014))).toMatchObject({ state: 'queued', failures: 0 })

    made.gitHub.open({ number: 1016, review: 'failure' })
    made.tick()
    made.gitHub.pulls.get(1016)!.head = sha('b')
    await once(node)
    made.tick()
    expect(taskState(made.db, prKey(1016)).state).toBe('superseded')
  })
})
