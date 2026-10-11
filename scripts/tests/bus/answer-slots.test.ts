import type { Answered, AnswerRequest, AnswerRun } from '../../bus/answerer.js'
import type { CardTreeTools } from '../../bus/card-tree.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { answerInSlots, AnswerWorker, priorityOf, startAnswerWorkers } from '../../bus/answer-worker.js'
import { claudeAnswerer } from '../../bus/answerer.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED, CARD_STOPPED } from '../../bus/inbox.js'
import { queueTask } from '../../bus/queue.js'
import { SLOTS, slotsOf } from '../../bus/scheduler.js'
import { sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const PUSHED = sha('e')

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
  const parts = { db: bench.db, ownerMerges: () => '', clock: bench.clock.now, session: 'slots', cardText, trees: cardTrees }
  return {
    ...bench,
    cards,
    inFlight,
    answered,
    workers: (slots: number) => startAnswerWorkers({ ...parts, answerer }, slots),
    prompted: (runs: AnswerRun[]) => new AnswerWorker({ ...parts, answerer: claudeAnswerer(path.join(trees, 'answers'), {
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
    close: (): void => {
      bench.close()
      rmSync(trees, { recursive: true, force: true })
    },
  }
}

describe('answer slots', () => {
  it('answer has three slots, like review', () => {
    expect(SLOTS.answer).toBe(SLOTS.review)
    expect(slotsOf('answer', {})).toBe(3)
  })

  it('three answer tasks on three card trees run at once', async () => {
    const bench = slotsBench()
    for (const cardId of [900, 901, 902])
      bench.asked(cardId)
    bench.tick()
    const workers = bench.workers(slotsOf('answer', {}))
    expect(workers.map(worker => worker.actor)).toEqual(['worker:answer:slots-1', 'worker:answer:slots-2', 'worker:answer:slots-3'])

    const allThree = bench.whenInFlight(3)
    const steps = workers.map(worker => worker.step())
    await allThree
    expect(bench.inFlight.map(request => request.lease.cardId).sort()).toEqual([900, 901, 902])
    bench.finishAll()
    expect((await Promise.all(steps)).map(step => step.kind)).toEqual(['answered', 'answered', 'answered'])
    bench.close()
  })

  it('two answer tasks on one card tree never run at once', async () => {
    const bench = slotsBench()
    bench.asked(1090)
    bench.gitHub.open({ number: 990, review: 'failure' })
    bench.asked(901)
    bench.tick()
    queueTask(bench.db, bench.clock.now().toISOString(), { queue: 'answer', cardId: 1090, pr: 990, head: sha('a') })
    const onCard = bench.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'answer' AND state = 'queued' AND card_id = 1090`).get() as { n: number }
    expect(onCard.n).toBe(2)

    const [first, second, third] = bench.workers(3)
    const both = bench.whenInFlight(2)
    const firstStep = first!.step()
    const secondStep = second!.step()
    await both
    expect(bench.inFlight.map(request => request.lease.cardId).sort()).toEqual([1090, 901])
    expect(await third!.step()).toEqual({ kind: 'idle' })

    bench.finishAll()
    await Promise.all([firstStep, secondStep])
    const one = bench.whenInFlight(1)
    const thirdStep = third!.step()
    await one
    expect(bench.inFlight.map(request => request.lease.cardId)).toEqual([1090])
    bench.finishAll()
    await thirdStep
    expect(bench.answered.sort()).toEqual([1090, 1090, 901])
    bench.close()
  })

  it('with several tasks queued in answer, the task of a p0 card is leased first', async () => {
    const bench = slotsBench()
    for (const cardId of [900, 901, 902])
      bench.asked(cardId)
    bench.cards.set(900, parkedCard(900, 'who: shift', 'an ordinary card'))
    bench.cards.set(902, parkedCard(902, 'who: shift\npriority: p0', 'the owner ordered it first'))
    bench.tick()
    expect(priorityOf(id => bench.cards.get(id) ?? null, 902)).toBe('p0')
    expect(priorityOf(id => bench.cards.get(id) ?? null, 900)).toBeNull()

    const [worker] = bench.workers(1)
    const one = bench.whenInFlight(1)
    const step = worker!.step()
    await one
    expect(bench.inFlight.map(request => request.lease.cardId)).toEqual([902])
    bench.finishAll()
    await step

    const next = bench.whenInFlight(1)
    const following = worker!.step()
    await next
    expect(bench.inFlight.map(request => request.lease.cardId)).toEqual([900])
    bench.finishAll()
    await following
    bench.close()
  })

  it('a witness admitted through --admit after the verdict appears in the answer round prompt', async () => {
    const bench = slotsBench()
    bench.asked(903)
    bench.cards.set(903, parkedCard(903, 'who: shift', 'Witnesses:\n- `pnpm exec vitest run scripts/tests/bus/first.test.ts` exits 0'))
    bench.tick()
    const admitted = '- `pnpm exec vitest run scripts/tests/bus/admitted-after-the-verdict.test.ts` exits 0; red on main'
    bench.cards.set(903, `${bench.cards.get(903)!.trimEnd()}\n${admitted}\n`)

    const runs: AnswerRun[] = []
    await bench.prompted(runs).step()

    expect(runs).toHaveLength(1)
    const prompt = runs[0]!.argv.at(-1)!
    expect(prompt).toContain(admitted)
    expect(prompt).toContain('scripts/tests/bus/first.test.ts')
    expect(prompt).toContain('a question on card #903')
    bench.close()
  })

  it('a round that throws in one slot ends no loop: the peer slot answers and its task completes, the fault goes to stderr', async () => {
    const bench = slotsBench()
    bench.asked(901)
    bench.tick()
    const [faulty, peer] = bench.workers(2)
    vi.spyOn(faulty!, 'step').mockRejectedValue(new Error('a fault on card #900'))
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stopped = new Error('the test stops the loops once the peer answered')
    const pause = async (): Promise<void> => {
      if (bench.answered.length > 0)
        throw stopped
      await new Promise(() => {})
    }

    const peerInFlight = bench.whenInFlight(1)
    const slots = answerInSlots([faulty!, peer!], pause)
    const ended = slots.catch((error: unknown) => error)
    await peerInFlight
    bench.finishAll()

    expect(await ended).toBe(stopped)
    expect(bench.answered).toEqual([901])
    const task = bench.db.prepare(`SELECT state FROM tasks WHERE queue = 'answer' AND card_id = 901`).get() as { state: string }
    expect(task.state).toBe('completed')
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('worker:answer:slots-1: the round threw'))
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('a fault on card #900'))
    vi.restoreAllMocks()
    bench.close()
  })
})
