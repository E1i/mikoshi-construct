import type { AnswerOutcome } from '../../bus/answer-executor.js'
import type { AnswerNodeParts, AnswerRun, AnswerStep } from '../../bus/answer-worker.js'
import type { Answered, Answerer } from '../../bus/answerer.js'
import type { CardTreeTools } from '../../bus/card-tree.js'
import type { LastHeartbeat } from '../../bus/heartbeat.js'
import type { Lease } from '../../bus/lease.js'
import type { DetectionMode, Scope } from '../../bus/node.js'
import type { AnswerInput } from '../../bus/prompt-store.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { Isolation, IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { AnswerExecutor } from '../../bus/answer-executor.js'
import { AnswerNode, answerNodeOf } from '../../bus/answer-worker.js'
import { answerPrompt, claudeAnswerer, tokensOf } from '../../bus/answerer.js'
import { DROPPED_LANE } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { busSessionPulse, lastHeartbeat } from '../../bus/heartbeat.js'
import { failTask, leaseNext } from '../../bus/lease.js'
import { NODE_CURSORS } from '../../bus/node.js'
import { answerCandidates, FAILURES_TO_STOP, keyOf, queueTask } from '../../bus/queue.js'
import { DECISIONS_SCOPE, OWNERS_UNDER_ANY_SHARD, VERSION_PR_RESERVATION } from '../../bus/shards.js'
import { PREPUSH_COMMAND } from '../../ci/prepush.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_MOVED, CARD_STARTED, CARD_STOPPED, MERGE_DONE, NODE_DETECTED, NODE_EQUIVALENCE, POLICY_DENIED, SHARD_DECIDED, SHARD_ISSUED, TASK_ENQUEUED } from '../../core/events.js'
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

function admitted(made: MergeBench, cardId: number): void {
  const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: `#${cardId}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
}

function dropped(made: MergeBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_MOVED}:${cardId}`, payload: { lane: DROPPED_LANE }, legacy: false })
}

function closedAfterAnEarlierMerge(made: MergeBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: MERGE_DONE, actor: 'worker:merge:worker-0', cardId, pr: 989, head: sha('e'), dedupeKey: `${MERGE_DONE}:989`, payload: { commit: sha('f'), rule: 'auto' }, legacy: false })
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:worker-0', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

const NOT_MINE: Record<string, (made: MergeBench, cardId: number) => void> = { dropped, closed: closedAfterAnEarlierMerge }

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
    node.failOnNextCall(1)
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

  it('a refused owner question stops the card as a question', async () => {
    const refusals: Record<string, (owner: string) => object> = {
      write: owner => ({ result: 'the owner file was refused', permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: owner, content: `${OWNER_QUESTION}\n` } }] }),
      bash: owner => ({ result: OWNER_QUESTION, permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: `echo question > ${owner}` } }] }),
    }
    for (const [tool, refusal] of Object.entries(refusals)) {
      const made = bench()
      const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
      const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
      const published: string[] = []
      const answers = path.join(trees, 'answers')
      const answerer = claudeAnswerer(answers, {
        cardText: () => null,
        available: () => true,
        remoteHead: () => sha('a'),
        spawn: async (run) => {
          const owner = run.stdoutPath.replace(/\.out\.jsonl$/, '.owner.txt')
          writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', ...refusal(owner) })}\n`)
          return 0
        },
        newSession: () => 'new-session-1',
        publish: card => published.push(card.branch),
      })
      const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees })

      expect(await executor.answer(lease()), tool).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: OWNER_QUESTION })
      expect(eventsOf(made.db, CARD_STOPPED).map(each => each.reason), tool).toEqual(['question.agent', 'question.owner'])
      expect(published, tool).toEqual([])
    }
  })

  it('an answering session has a session.heartbeat while it lives', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const answers = path.join(trees, 'answers')
    const seen: (LastHeartbeat | null)[] = []
    const answerer = claudeAnswerer(answers, {
      cardText: () => null,
      available: () => true,
      remoteHead: () => sha('a'),
      spawn: async (run) => {
        seen.push(lastHeartbeat(made.db, 905))
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
        return 0
      },
      newSession: () => 'new-session-1',
      publish: () => {},
      pulse: busSessionPulse(made.db.location()!, made.clock.now, () => ({})),
    })
    const held = lease()
    expect(lastHeartbeat(made.db, 905)).toBeNull()
    await answerer({ lease: held, source: { kind: 'question', detail: OWNER_QUESTION, widen: null, events: [] }, widened: null, card: { session: 'card-session-1', worktree: path.join(trees, 'mc-905'), branch: 'feat/card-905' } })
    expect(seen).toEqual([{ ts: made.clock.now().toISOString(), pr: null, head: null, step: 'answer', session: 'card-session-1' }])
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
    expect(eventsOf(made.db, CARD_ANSWERED)).toEqual([{ session: 'card-session-1', worktree: path.join(trees, 'mc-905'), resumed: true, source: 'question', from: sha('a'), to: sha('e'), minutes: 7.5, tokens: 48_200 }])
  })

  it('a session that exits on the context threshold with no new head is retried once in a new session', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const contexts = new Map<string, number>([['card-session-1', 120_000]])
    const runs: string[][] = []
    const heads = [sha('a'), sha('a'), sha('a'), sha('e')]
    const answerer = claudeAnswerer(path.join(trees, 'answers'), {
      cardText: () => null,
      available: () => true,
      remoteHead: () => heads.shift() ?? null,
      spawn: async (run) => {
        runs.push(run.argv)
        const session = run.argv.includes('--resume') ? 'card-session-1' : 'new-session-1'
        contexts.set(session, session === 'card-session-1' ? 201_662 : 40_000)
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ended' })}\n`)
        return 0
      },
      newSession: () => 'new-session-1',
      publish: () => {},
      context: session => contexts.get(session) ?? null,
      contextWarn: () => 200_000,
      diff: () => 'diff --git a/x b/x',
    })
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees })

    expect(await executor.answer(lease())).toMatchObject({ kind: 'answered', session: 'new-session-1', resumed: false, head: sha('e') })
    expect(runs.map(argv => argv.includes('--resume'))).toEqual([true, false])
    expect(eventsOf(made.db, CARD_STOPPED).map(each => each.reason)).toEqual(['question.agent'])
    expect(eventsOf(made.db, CARD_ANSWERED)).toMatchObject([{ session: 'new-session-1', resumed: false }])
  })

  it('a retried session that exits on the context threshold again stops the card as a fault', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const requests: Parameters<Answerer>[0][] = []
    const answerer: Answerer = async (request) => {
      requests.push(request)
      return { session: request.fresh === true ? 'new-session-1' : 'card-session-1', resumed: request.fresh !== true, atContextWarn: true, before: sha('a'), after: sha('a'), owner: null }
    }
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees })

    expect(await executor.answer(lease())).toMatchObject({ kind: 'stopped', reason: 'fault' })
    expect(requests.map(request => request.fresh)).toEqual([false, true])
  })

  it('the session input is rebuilt from card.answered alone with no handoff directory', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const cardBody = '#905 answer-input [implement/netwatch/S/cheap/auto]\n\nthe card body'
    let given = ''
    const answerer = async (request: Parameters<Answerer>[0]): Promise<Answered & { input: AnswerInput }> => {
      given = answerPrompt(request, '/answers/card-session-1.1.owner.txt', cardBody)
      return { session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null, input: { prompt: given, cardBody } }
    }
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees, prompts: path.join(trees, 'prompts') })

    expect(await executor.answer(lease())).toMatchObject({ kind: 'answered', head: sha('e') })
    const [answered] = eventsOf(made.db, CARD_ANSWERED) as { prompt_sha: string, prompt_path: string, card_body_sha: string, input?: unknown }[]
    expect(existsSync(path.join(trees, 'handoff'))).toBe(false)
    expect(answered!.input).toBeUndefined()
    const rebuilt = readFileSync(answered!.prompt_path, 'utf8')
    expect(rebuilt).toBe(given)
    expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(answered!.prompt_sha)
    expect(answered!.card_body_sha).toBe(createHash('sha256').update(cardBody).digest('hex'))
  })

  it('card.answered is recorded with the prompt sha and the reason when the prompt cannot be stored', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const blocker = path.join(trees, 'a-file')
    writeFileSync(blocker, '')
    const answerer = async (): Promise<Answered & { input: AnswerInput }> => ({ session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null, input: { prompt: 'the answer prompt', cardBody: 'the card body' } })
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees, prompts: path.join(blocker, 'prompts') })

    expect(await executor.answer(lease())).toMatchObject({ kind: 'answered', head: sha('e') })
    const [answered] = eventsOf(made.db, CARD_ANSWERED)
    expect(answered).toMatchObject({ prompt_sha: createHash('sha256').update('the answer prompt').digest('hex'), prompt_unstored: expect.any(String) as unknown, card_body_sha: createHash('sha256').update('the card body').digest('hex') })
    expect(answered).not.toHaveProperty('prompt_path')
  })

  it('card.answered carries no measurement from an answerer that reports no usage', async () => {
    const made = bench()
    const { trees, lease } = questionUnderShard(made, made.clock.now(), null)
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const answerer: Answerer = async () => ({ session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null })
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees })
    expect(await executor.answer(lease())).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(eventsOf(made.db, CARD_ANSWERED)).toEqual([{ session: 'card-session-1', worktree: path.join(trees, 'mc-905'), resumed: true, source: 'question', from: sha('a'), to: sha('e') }])
  })

  it('the answer round prompt names the window gate of D-194 with the pre-push tests, not pnpm run quality', () => {
    const prompt = answerPrompt({
      lease: { taskKey: 'answer:1079:925:head', queue: 'answer', cardId: 1079, pr: 925, head: sha('a'), leaseGen: 1, actor: 'worker:answer:s' },
      source: { kind: 'changes', findings: ['a.ts:1 a finding'], events: [] },
      widened: null,
      card: { session: 's', worktree: '/trees/mc-1079', branch: 'feat/window-gate-by-layers' },
    }, '/answers/s.1.owner.txt', null)

    expect(prompt).toContain('D-194')
    expect(prompt).toContain(PREPUSH_COMMAND)
    expect(prompt).not.toContain('pnpm gate:window')
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

  it('answer skips a candidate cardContract reads as not mine', async () => {
    for (const [state, endedInTheBus] of Object.entries(NOT_MINE)) {
      const made = bench()
      admitted(made, 1090)
      const stop = stopped(made, 1090)
      queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: 1090, stop })
      endedInTheBus(made, 1090)
      made.tick()
      const answerer = vi.fn<Answerer>(async () => {
        throw new Error('a card that is not the bus\'s is never answered')
      })
      const node = new AnswerNode({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, session: 'node-1', cardText: () => null, mode: 'live', env: {} })
      await once(node)
      await once(node)

      expect(answerer, state).not.toHaveBeenCalled()
      expect(eventsOf(made.db, CARD_ANSWERED), state).toEqual([])
      expect(eventsOf(made.db, POLICY_DENIED), state).toEqual([expect.objectContaining({ command: 'answer', kind: 'technical', reason: 'not_mine', detail: expect.stringContaining(`is ${state} in the bus`) })])
      expect(taskState(made.db, questionKey(1090, stop)).state, state).toBe('withdrawn')
    }
  })
})
