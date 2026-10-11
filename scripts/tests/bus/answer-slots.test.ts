import type { Answered, AnswerRequest } from '../../bus/answerer.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startAnswerWorkers } from '../../bus/answer-worker.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED, CARD_STOPPED } from '../../bus/inbox.js'
import { queueTask } from '../../bus/queue.js'
import { SLOTS, slotsOf } from '../../bus/scheduler.js'
import { sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const PUSHED = sha('e')

function slotsBench() {
  const bench = mergeBench()
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-slots-'))
  const ts = (): string => bench.clock.now().toISOString()
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
  return {
    ...bench,
    inFlight,
    answered,
    workers: (slots: number) => startAnswerWorkers({ db: bench.db, answerer, ownerMerges: () => '', clock: bench.clock.now, session: 'slots' }, slots),
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
})
