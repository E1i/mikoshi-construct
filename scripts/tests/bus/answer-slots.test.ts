import type { Answered, AnswerRequest, AnswerRun } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { Lease } from '../../core/lease.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { AnswerNode, priorityOf } from '../../nodes/answer/answer-worker.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { appendEvent } from '../../core/db.js'
import { expireLeases, LEASE_MS, RENEW_MS } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { SLOTS, slotsOf, slotsVariable } from '../../supervisor/scheduler.js'
import { openDatabase } from '../../core/sqlite.js'
import { CARD_STARTED, CARD_STOPPED, REVIEW_RECORDED } from '../../core/events.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const PUSHED = sha('e')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function parkedCard(cardId: number, header: string, body: string): string {
  return `card: #${cardId} task-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: scripts/bus/**\n${header}\n\n${body}\n`
}

function slotsBench() {
  const bench = mergeBench()
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-slots-'))
  const ts = (): string => bench.clock.now().toISOString()
  const cards = new Map<number, string>()
  const cardText = (cardId: number): string | null => cards.get(cardId) ?? null
  const cardTrees: CardTreeTools = { home: path.join(trees, 'worktrees'), exists: () => true, branchOf: pr => `feat/card-${pr + 100}`, recreate: () => {}, bringTo: () => {} }
  const inFlight: AnswerRequest[] = []
  const answered: number[] = []
  const finishes: (() => void)[] = []
  let allIn: () => void = () => {}
  let expected = 0
  const answerer = async (request: AnswerRequest): Promise<Answered> => {
    inFlight.push(request)
    if (inFlight.length === expected)
      allIn()
    await new Promise<void>(resolve => finishes.push(resolve))
    inFlight.splice(inFlight.indexOf(request), 1)
    answered.push(request.lease.cardId)
    return { session: request.card.session, resumed: true, before: sha('a'), after: PUSHED, owner: null }
  }
  const parts = { db: bench.db, ownerMerges: () => '', clock: bench.clock.now, session: 'slots', cardText, trees: cardTrees, mode: 'shadow' as const }
  return {
    ...bench,
    cards,
    inFlight,
    answered,
    node: (slots: number) => new AnswerNode({ ...parts, answerer, env: { [slotsVariable('answer')]: String(slots) } }),
    prompted: (runs: AnswerRun[]) => new AnswerNode({ ...parts, env: { [slotsVariable('answer')]: '1' }, answerer: claudeAnswerer(path.join(trees, 'answers'), {
      cardText,
      available: () => true,
      remoteHead: () => null,
      spawn: async (run) => {
        runs.push(run)
        return 0
      },
      newSession: () => 'new-session-1',
      publish: () => {},
    }) }),
    whenInFlight: (count: number): Promise<void> => {
      expected = count
      return new Promise(resolve => (allIn = resolve))
    },
    finishAll: (): void => {
      for (const finish of finishes.splice(0))
        finish()
    },
    asked: (cardId: number): void => {
      const worktree = path.join(trees, `mc-${cardId}`)
      mkdirSync(worktree, { recursive: true })
      appendEvent(bench.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}`, payload: { session: `card-session-${cardId}`, worktree, branch: `feat/card-${cardId}`, base: sha('1') }, legacy: false })
      appendEvent(bench.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: 'question.agent', detail: `a question on card #${cardId}` }, legacy: false })
    },
    taskStates: (): Record<number, string[]> => {
      const states: Record<number, string[]> = {}
      for (const row of bench.db.prepare(`SELECT card_id, state FROM tasks WHERE queue = 'answer' ORDER BY id`).all() as { card_id: number, state: string }[])
        (states[row.card_id] ??= []).push(row.state)
      return states
    },
    close: (): void => {
      bench.close()
      rmSync(trees, { recursive: true, force: true })
    },
  }
}

function runUntil(node: AnswerNode, done: () => boolean): Promise<void> {
  const controller = new AbortController()
  return node.run({
    pause: async () => {
      if (done())
        controller.abort()
    },
    signal: controller.signal,
  })
}

describe('answer slots', () => {
  it('answer has three slots, like review', () => {
    expect(SLOTS.answer).toBe(SLOTS.review)
    expect(slotsOf('answer', {})).toBe(3)
  })

  it('three answer tasks on three card trees run at once in the three slots of one node', async () => {
    const bench = slotsBench()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const cardId of [900, 901, 902])
      bench.asked(cardId)
    bench.tick()
    const node = bench.node(slotsOf('answer', {}))
    expect(node.actor).toBe('worker:answer:slots')
    expect(node.slots).toBe(3)

    const allThree = bench.whenInFlight(3)
    const running = runUntil(node, () => bench.answered.length === 3)
    await allThree
    expect(bench.inFlight.map(request => request.lease.cardId).sort()).toEqual([900, 901, 902])
    expect(node.getState().leased).toHaveLength(3)
    bench.finishAll()
    await running
    expect(bench.taskStates()).toEqual({ 900: ['completed'], 901: ['completed'], 902: ['completed'] })
    bench.close()
  })

  it('two answer tasks on one card tree never run at once', async () => {
    const bench = slotsBench()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    bench.asked(1090)
    bench.gitHub.open({ number: 990, review: 'failure' })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1090, pr: 990, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:990`, payload: { head: sha('a'), verdict: 'changes', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    bench.asked(901)
    bench.tick()
    queueTask(bench.db, bench.clock.now().toISOString(), { queue: 'answer', cardId: 1090, pr: 990, head: sha('a') })
    const onCard = bench.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'answer' AND state = 'queued' AND card_id = 1090`).get() as { n: number }
    expect(onCard.n).toBe(2)

    const node = bench.node(3)
    const both = bench.whenInFlight(2)
    const running = runUntil(node, () => bench.answered.length === 3)
    await both
    expect(bench.inFlight.map(request => request.lease.cardId).sort()).toEqual([1090, 901])
    expect(node.getState().leased).toHaveLength(2)

    const one = bench.whenInFlight(1)
    bench.finishAll()
    await one
    expect(bench.inFlight.map(request => request.lease.cardId)).toEqual([1090])
    bench.finishAll()
    await running
    expect(bench.answered.sort()).toEqual([1090, 1090, 901])
    bench.close()
  })

  it('with several tasks queued in answer, the task of a p0 card is leased first', async () => {
    const bench = slotsBench()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const cardId of [900, 901, 902])
      bench.asked(cardId)
    bench.cards.set(900, parkedCard(900, 'who: shift', 'an ordinary card'))
    bench.cards.set(902, parkedCard(902, 'who: shift\npriority: p0', 'the owner ordered it first'))
    bench.tick()
    expect(priorityOf(id => bench.cards.get(id) ?? null, 902)).toBe('p0')
    expect(priorityOf(id => bench.cards.get(id) ?? null, 900)).toBeNull()

    const node = bench.node(1)
    const one = bench.whenInFlight(1)
    const running = runUntil(node, () => bench.answered.length === 2)
    await one
    expect(bench.inFlight.map(request => request.lease.cardId)).toEqual([902])

    const next = bench.whenInFlight(1)
    bench.finishAll()
    await next
    expect(bench.inFlight.map(request => request.lease.cardId)).toEqual([900])
    bench.finishAll()
    await running
    bench.close()
  })

  it('a witness admitted through --admit after the verdict appears in the answer round prompt', async () => {
    const bench = slotsBench()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    bench.asked(903)
    bench.cards.set(903, parkedCard(903, 'who: shift', 'Witnesses:\n- `pnpm exec vitest run scripts/tests/bus/first.test.ts` exits 0'))
    bench.tick()
    const admitted = '- `pnpm exec vitest run scripts/tests/bus/admitted-after-the-verdict.test.ts` exits 0; red on main'
    bench.cards.set(903, `${bench.cards.get(903)!.trimEnd()}\n${admitted}\n`)

    const runs: AnswerRun[] = []
    await runUntil(bench.prompted(runs), () => true)

    expect(runs).toHaveLength(1)
    const prompt = runs[0]!.argv.at(-1)!
    expect(prompt).toContain(admitted)
    expect(prompt).toContain('scripts/tests/bus/first.test.ts')
    expect(prompt).toContain('a question on card #903')
    bench.close()
  })

  it('the node timer survives a busy database and stops on a stale lease', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = slotsBench()
    bench.asked(904)
    bench.tick()
    const inFlight = bench.whenInFlight(1)
    const running = runUntil(bench.node(1), () => bench.answered.length > 0)
    await inFlight
    const { task_key: key } = bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND card_id = 904`).get() as { task_key: string }
    const beat = async (): Promise<void> => {
      bench.clock.advance(RENEW_MS)
      await vi.advanceTimersByTimeAsync(RENEW_MS)
    }

    bench.db.exec('PRAGMA busy_timeout = 0')
    const other = openDatabase(bench.busPath)
    other.exec('BEGIN IMMEDIATE')
    await beat()
    other.exec('ROLLBACK')
    other.close()
    expect(eventsOf(bench.db, 'task.renewed')).toEqual([])
    const notRenewed = printed.mock.calls.map(call => String(call[0])).filter(line => line.includes(`${key}: the lease was not renewed this beat`))
    expect(notRenewed).toHaveLength(1)
    expect(notRenewed[0]).toContain('database is locked')

    await beat()
    expect(eventsOf(bench.db, 'task.renewed')).toHaveLength(1)

    bench.clock.advance(LEASE_MS + 1)
    expect(expireLeases(bench.db, bench.clock.now().toISOString())).toEqual([key])
    await beat()
    await beat()
    expect(eventsOf(bench.db, 'task.renewed')).toHaveLength(1)
    bench.finishAll()
    await running
    bench.close()
  })

  it('a round that throws in one slot ends no slot: the peer answers, the fault goes to stderr, and the lease is renewed while a round runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const bench = slotsBench()
    const answer = AnswerExecutor.prototype.answer
    vi.spyOn(AnswerExecutor.prototype, 'answer').mockImplementation(async function (this: AnswerExecutor, lease: Lease) {
      if (lease.cardId === 900)
        throw new Error('a fault on card #900')
      return answer.call(this, lease)
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    bench.asked(900)
    bench.asked(901)
    bench.tick()
    const node = bench.node(2)

    const peerInFlight = bench.whenInFlight(1)
    const running = runUntil(node, () => bench.answered.length > 0)
    await peerInFlight
    for (let beat = 0; beat < 2; beat += 1) {
      bench.clock.advance(RENEW_MS)
      await vi.advanceTimersByTimeAsync(RENEW_MS)
    }
    expect(eventsOf(bench.db, 'task.renewed')).toHaveLength(2)
    const peer = bench.db.prepare(`SELECT lease_until FROM tasks WHERE queue = 'answer' AND card_id = 901`).get() as { lease_until: string }
    expect(peer.lease_until).toBe(new Date(bench.clock.now().getTime() + LEASE_MS).toISOString())
    bench.finishAll()
    await running

    expect(bench.answered).toEqual([901])
    expect(bench.taskStates()).toEqual({ 900: ['leased'], 901: ['completed'] })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('worker:answer:slots: the round on'))
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('a fault on card #900'))
    bench.close()
  })
})
