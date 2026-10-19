import type { DatabaseSync } from 'node:sqlite'
import type { IsolationReader } from '../../ghosts/isolation.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { prBodySha, taskKey } from '../../bus/identifiers.js'
import { importJournal } from '../../bus/import.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { completeTask, leaseNext } from '../../bus/lease.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { cardBodyShaOfCard, queueTask, supersedeTask, TASK_SUPERSEDED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { fullReview } from '../../bus/review-depth.js'
import { REVIEW_ROUNDS_SPENT, ReviewWorker, roundLimitLine } from '../../bus/review-worker.js'
import { BusTick } from '../../bus/run.js'
import { cardBody, Clock, FakeGitHub, sha } from './github-fake.js'
import { detectMerge } from './merge-detection.js'
import { detectReview } from './review-detection.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const IN_MEMORY = ':memory:'

function setUp(file?: string): { db: DatabaseSync, gitHub: FakeGitHub, clock: Clock, tick: () => void } {
  const db = openBus(file ?? onDisk())
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now)
  let first = true
  const tick = (): void => {
    if (!first)
      clock.advance(TICK_MS)
    first = false
    busTick.run()
    detectReview({ db, gitHub, clock })
    detectMerge({ db, gitHub, clock })
  }
  return { db, gitHub, clock, tick }
}

function onDisk(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-review-queue-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function tasks(db: DatabaseSync): { task_key: string, state: string }[] {
  return db.prepare('SELECT task_key, state FROM tasks ORDER BY id').all() as { task_key: string, state: string }[]
}

function taskEvents(db: DatabaseSync): { type: string, dedupe_key: string }[] {
  return db.prepare(`SELECT type, dedupe_key FROM events WHERE type LIKE 'task.%' ORDER BY id`).all() as { type: string, dedupe_key: string }[]
}

const review = (pr: number, head: string): string => taskKey({ queue: 'review', cardId: pr + 100, pr, head, input: { prBody: prBodySha(cardBody(pr)), cardBody: null } })

function intakeLine(cardId: number, bodySha: string): string {
  return JSON.stringify({ event: 'intake', task: String(cardId), card: `#${cardId} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`, confirmation: 'auto', corrections: [], bodySha, source: 'admit', ts: '2026-10-11T14:00:00.000Z' })
}

describe('review queue', () => {
  it('a pr with a new head and no verdict enters review within 2 ticks', () => {
    const { db, gitHub, tick } = setUp()
    gitHub.open({ number: 920 })
    tick()
    expect(tasks(db)).toEqual([{ task_key: review(920, sha('a')), state: 'queued' }])

    gitHub.open({ number: 920, head: sha('b') })
    let ticks = 0
    while (ticks < 2 && !tasks(db).some(task => task.task_key === review(920, sha('b')))) {
      tick()
      ticks += 1
    }
    expect(tasks(db)).toContainEqual({ task_key: review(920, sha('b')), state: 'queued' })
    db.close()
  })

  it('tasks of the old head become superseded on a new head', () => {
    const { db, gitHub, tick } = setUp()
    gitHub.open({ number: 921 })
    gitHub.open({ number: 922 })
    tick()
    gitHub.open({ number: 921, head: sha('c') })
    tick()

    expect(tasks(db)).toEqual([
      { task_key: review(921, sha('a')), state: 'superseded' },
      { task_key: review(922, sha('a')), state: 'queued' },
      { task_key: review(921, sha('c')), state: 'queued' },
    ])
    expect(taskEvents(db).filter(event => event.type === TASK_SUPERSEDED).map(event => event.dedupe_key)).toEqual([expect.stringMatching(new RegExp(`^${TASK_SUPERSEDED}:${review(921, sha('a'))}:after-\\d+$`))])
    const live = projectionDump(db)
    reduce(db)
    expect(projectionDump(db)).toBe(live)
    tick()
    expect(taskEvents(db)).toHaveLength(4)
    db.close()
  })

  it('a task row and its task.* event are written in one transaction', () => {
    const { db } = setUp()
    const task = { queue: 'review' as const, cardId: 1023, pr: 923, head: sha('d') }
    db.exec(`CREATE TRIGGER no_task_rows BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'no task rows'); END;`)
    expect(() => queueTask(db, '2026-10-09T12:00:00.000Z', task)).toThrow(/no task rows/)
    expect(taskEvents(db)).toEqual([])

    db.exec(`DROP TRIGGER no_task_rows; CREATE TRIGGER no_task_events BEFORE INSERT ON events WHEN NEW.type LIKE 'task.%' BEGIN SELECT RAISE(ABORT, 'no task events'); END;`)
    expect(() => queueTask(db, '2026-10-09T12:00:00.000Z', task)).toThrow(/no task events/)
    expect(tasks(db)).toEqual([])

    db.exec('DROP TRIGGER no_task_events')
    expect(queueTask(db, '2026-10-09T12:00:00.000Z', task)).toBe(true)
    const row = db.prepare('SELECT event_id FROM tasks').get() as { event_id: number }
    expect(db.prepare('SELECT type, dedupe_key FROM events WHERE id = ?').get(row.event_id)).toEqual({ type: 'task.enqueued', dedupe_key: `task.enqueued:${taskKey(task)}` })
    expect(queueTask(db, '2026-10-09T12:01:00.000Z', task)).toBe(false)
    expect(taskEvents(db)).toHaveLength(1)
    db.close()
  })

  it('a new head without a status or verdict returns to review and the old head tasks are superseded', () => {
    const { db, gitHub, clock, tick } = setUp()
    gitHub.open({ number: 924 })
    tick()
    completeTask(db, clock.now().toISOString(), leaseNext(db, clock.now().toISOString(), 'review', 'worker:review:s1')!, [])
    gitHub.open({ number: 924, review: 'success' })
    tick()
    const merge = taskKey({ queue: 'merge', cardId: 1024, pr: 924, head: sha('a') })
    expect(tasks(db)).toEqual([{ task_key: review(924, sha('a')), state: 'completed' }, { task_key: merge, state: 'queued' }])

    gitHub.open({ number: 924, head: sha('e'), required: 'pending' })
    tick()
    expect(tasks(db)).toEqual([{ task_key: review(924, sha('a')), state: 'completed' }, { task_key: merge, state: 'superseded' }])

    gitHub.open({ number: 924, head: sha('e') })
    tick()
    expect(tasks(db)).toEqual([
      { task_key: review(924, sha('a')), state: 'completed' },
      { task_key: merge, state: 'superseded' },
      { task_key: review(924, sha('e')), state: 'queued' },
    ])
    db.close()
  })

  it('an edit of the pull request body or of the card body after changes on head X gives a new review.recorded on X with no new commit', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const body = cardBody(925)
    const worker = new ReviewWorker({
      isolation: sandboxed,
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(925)!.review = status.state
      },
      reviewer: async () => ({ verdict: 'changes', findings: ['the pull request body names no ladder reason'], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
    })
    const recorded = (): { head: string, task: string }[] => (db.prepare(`SELECT head, dedupe_key FROM events WHERE type = '${REVIEW_RECORDED}' ORDER BY id`).all() as { head: string, dedupe_key: string }[]).map(row => ({ head: row.head, task: row.dedupe_key.split(':').slice(1, -1).join(':') }))
    const keyOf = (prBody: string, card: string | null): string => taskKey({ queue: 'review', cardId: 1025, pr: 925, head: sha('a'), input: { prBody: prBodySha(prBody), cardBody: card } })

    gitHub.open({ number: 925, body })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes', taskKey: keyOf(body, null) })
    tick()
    tick()
    expect(await worker.step()).toEqual({ kind: 'idle' })

    const edited = `${body}\n\nThe ladder: MORSE predicts ladder by rule doubt.`
    gitHub.open({ number: 925, body: edited, review: 'failure' })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', taskKey: keyOf(edited, null) })
    tick()
    expect(await worker.step()).toEqual({ kind: 'idle' })

    importJournal(db, intakeLine(1025, '0123abcd4567ef89'))
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', taskKey: keyOf(edited, '0123abcd4567ef89') })
    tick()
    expect(await worker.step()).toEqual({ kind: 'idle' })

    expect(recorded()).toEqual([
      { head: sha('a'), task: keyOf(body, null) },
      { head: sha('a'), task: keyOf(edited, null) },
      { head: sha('a'), task: keyOf(edited, '0123abcd4567ef89') },
    ])
    expect(gitHub.pulls.get(925)!.head).toBe(sha('a'))
    const live = projectionDump(db)
    reduce(db)
    expect(projectionDump(db)).toBe(live)
    db.close()
  })

  it('a changes verdict on a head, a card amend and a review on the same head do not lead to a merge of that head', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const verdicts: ('changes' | 'pass')[] = ['changes', 'pass']
    const worker = new ReviewWorker({
      isolation: sandboxed,
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(931)!.review = status.state
      },
      reviewer: async () => ({ verdict: verdicts.shift()!, findings: [], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
    })
    gitHub.open({ number: 931, body: cardBody(931) })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })
    tick()
    importJournal(db, intakeLine(1031, '0123abcd4567ef89'))
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })
    tick()
    tick()
    expect(gitHub.pulls.get(931)!.review).toBe('failure')
    expect(tasks(db).filter(task => task.task_key.startsWith('merge:'))).toEqual([])
    db.close()
  })

  function passingWorker(db: DatabaseSync, gitHub: FakeGitHub, clock: Clock, pr: number): ReviewWorker {
    return new ReviewWorker({
      isolation: sandboxed,
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(pr)!.review = status.state
      },
      reviewer: async () => ({ verdict: 'pass', findings: [], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
    })
  }

  const inputKey = (pr: number, card: string | null): string => taskKey({ queue: 'review', cardId: pr + 100, pr, head: sha('a'), input: { prBody: prBodySha(cardBody(pr)), cardBody: card } })

  it('a pass on a head and a card amend queue a review of the new input on the same head', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const worker = passingWorker(db, gitHub, clock, 932)
    gitHub.open({ number: 932, body: cardBody(932) })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass', taskKey: inputKey(932, null) })
    tick()
    importJournal(db, intakeLine(1032, '0123abcd4567ef89'))
    tick()

    expect(tasks(db)).toContainEqual({ task_key: inputKey(932, '0123abcd4567ef89'), state: 'queued' })
    expect(gitHub.pulls.get(932)!.head).toBe(sha('a'))
    db.close()
  })

  it('a pass on a head with no new input queues no second review', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const worker = passingWorker(db, gitHub, clock, 934)
    gitHub.open({ number: 934, body: cardBody(934) })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass', taskKey: inputKey(934, null) })
    tick()
    tick()

    expect(await worker.step()).toEqual({ kind: 'idle' })
    expect(tasks(db).filter(task => task.task_key.startsWith('review:'))).toEqual([{ task_key: inputKey(934, null), state: 'completed' }])
    db.close()
  })

  it('a head with a queued review of a new input after a pass is no merge candidate until that review is recorded', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const worker = passingWorker(db, gitHub, clock, 933)
    const merge = taskKey({ queue: 'merge', cardId: 1033, pr: 933, head: sha('a') })
    const merges = (): { task_key: string, state: string }[] => tasks(db).filter(task => task.task_key === merge)
    gitHub.open({ number: 933, body: cardBody(933), mergeable_state: 'behind' })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })
    tick()
    importJournal(db, intakeLine(1033, '0123abcd4567ef89'))
    tick()
    expect(tasks(db)).toContainEqual({ task_key: inputKey(933, '0123abcd4567ef89'), state: 'queued' })

    gitHub.open({ number: 933, body: cardBody(933), review: 'success' })
    tick()
    tick()
    expect(merges()).toEqual([])

    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass', taskKey: inputKey(933, '0123abcd4567ef89') })
    tick()
    expect(merges()).toEqual([{ task_key: merge, state: 'queued' }])
    db.close()
  })

  it('an edit of the pull request body after changes with no new head gives a review within two ticks', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const body = cardBody(930)
    const edited = `${body}\n\nThe ladder: the rule is named in the body.`
    const keyOf = (prBody: string): string => taskKey({ queue: 'review', cardId: 1030, pr: 930, head: sha('a'), input: { prBody: prBodySha(prBody), cardBody: null } })
    const worker = new ReviewWorker({
      isolation: sandboxed,
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(930)!.review = status.state
      },
      reviewer: async () => ({ verdict: 'changes', findings: ['the body names no rule'], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
    })
    gitHub.open({ number: 930, body })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes', taskKey: keyOf(body) })

    gitHub.open({ number: 930, body: edited, review: 'failure' })
    let ticks = 0
    while (ticks < 2 && !tasks(db).some(task => task.task_key === keyOf(edited))) {
      tick()
      ticks += 1
    }
    expect(tasks(db)).toContainEqual({ task_key: keyOf(edited), state: 'queued' })
    expect(gitHub.pulls.get(930)!.head).toBe(sha('a'))
    db.close()
  })

  it('a review queued under one body is superseded when the body changes before it runs', () => {
    const { db, gitHub, tick } = setUp()
    const body = cardBody(926)
    const edited = `${body}\n\nedited`
    gitHub.open({ number: 926, body })
    tick()
    gitHub.open({ number: 926, body: edited })
    tick()
    const keyOf = (prBody: string): string => taskKey({ queue: 'review', cardId: 1026, pr: 926, head: sha('a'), input: { prBody: prBodySha(prBody), cardBody: null } })
    expect(tasks(db)).toEqual([{ task_key: keyOf(body), state: 'superseded' }, { task_key: keyOf(edited), state: 'queued' }])
    db.close()
  })

  it('an edit of the pull request body and its revert before the review leases leave exactly one queued review on the head', () => {
    const { db, gitHub, tick } = setUp()
    const body = cardBody(927)
    const edited = `${body}\n\nedited`
    const keyOf = (prBody: string): string => taskKey({ queue: 'review', cardId: 1027, pr: 927, head: sha('a'), input: { prBody: prBodySha(prBody), cardBody: null } })
    const queued = (): string[] => (db.prepare(`SELECT task_key FROM tasks WHERE queue = 'review' AND state = 'queued'`).all() as { task_key: string }[]).map(row => row.task_key)

    for (const [text, current, left] of [[body, body, null], [edited, edited, body], [body, body, edited], [edited, edited, body], [body, body, edited]] as const) {
      gitHub.open({ number: 927, body: text })
      tick()
      expect(queued()).toEqual([keyOf(current)])
      if (left !== null)
        expect(tasks(db)).toContainEqual({ task_key: keyOf(left), state: 'superseded' })
    }
    expect(tasks(db)).toHaveLength(2)
    const live = projectionDump(db)
    reduce(db)
    expect(projectionDump(db)).toBe(live)
    db.close()
  })

  it('a review requeued by a revert and then leased is superseded by the next edit or push, leaving one live review on the pull request', () => {
    for (const next of ['edit', 'push'] as const) {
      const { db, gitHub, clock, tick } = setUp()
      const body = cardBody(928)
      const edited = `${body}\n\nedited`
      const keyOf = (prBody: string, head = sha('a')): string => taskKey({ queue: 'review', cardId: 1028, pr: 928, head, input: { prBody: prBodySha(prBody), cardBody: null } })
      const live = (): { task_key: string, state: string }[] => tasks(db).filter(task => task.state === 'queued' || task.state === 'leased')

      for (const text of [body, edited, body]) {
        gitHub.open({ number: 928, body: text })
        tick()
      }
      expect(live()).toEqual([{ task_key: keyOf(body), state: 'queued' }])
      expect(leaseNext(db, clock.now().toISOString(), 'review', 'worker:review:s1')?.taskKey).toBe(keyOf(body))

      gitHub.open(next === 'edit' ? { number: 928, body: edited } : { number: 928, body, head: sha('b') })
      tick()
      expect(tasks(db)).toContainEqual({ task_key: keyOf(body), state: 'superseded' })
      expect(live()).toEqual([{ task_key: next === 'edit' ? keyOf(edited) : keyOf(body, sha('b')), state: 'queued' }])
      db.close()
    }
  })

  it('one pull request keeps exactly one live review, of its current head and body, through every sequence of head pushes, body edits A→B→A and leases, and no supersede is lost', () => {
    type Step = 'A' | 'B' | 'push' | 'lease'
    const steps: Step[] = ['A', 'B', 'push', 'lease']
    const sequences = steps.flatMap(a => steps.flatMap(b => steps.flatMap(c => steps.map(d => [a, b, c, d]))))
    const bodies = { A: cardBody(929), B: `${cardBody(929)}\n\nedited` }
    const heads = ['a', 'b', 'c', 'd', 'e'].map(letter => sha(letter))
    for (const sequence of sequences) {
      const { db, gitHub, clock, tick } = setUp(IN_MEMORY)
      let body: keyof typeof bodies = 'A'
      let head = 0
      const expectOneLiveReview = (after: string): void => {
        const live = db.prepare(`SELECT task_key FROM tasks WHERE queue = 'review' AND pr = 929 AND state IN ('queued', 'leased')`).all() as { task_key: string }[]
        const current = taskKey({ queue: 'review', cardId: 1029, pr: 929, head: heads[head]!, input: { prBody: prBodySha(bodies[body]), cardBody: null } })
        expect({ after, live: live.map(row => row.task_key) }).toEqual({ after, live: [current] })
      }
      gitHub.open({ number: 929, body: bodies[body], head: heads[head] })
      tick()
      expectOneLiveReview('open')
      for (const [index, step] of sequence.entries()) {
        if (step === 'lease')
          leaseNext(db, clock.now().toISOString(), 'review', 'worker:review:s1')
        if (step === 'push')
          head += 1
        if (step === 'A' || step === 'B')
          body = step
        gitHub.open({ number: 929, body: bodies[body], head: heads[head] })
        tick()
        expectOneLiveReview(sequence.slice(0, index + 1).join(' → '))
      }
      const projection = projectionDump(db)
      reduce(db)
      expect(projectionDump(db)).toBe(projection)
      db.close()
    }
  }, 120_000)
})

describe('the review round limit of D-104', () => {
  const HEADS = [sha('a'), sha('b'), sha('c'), sha('d')]

  async function rounds(pr: number, verdicts: ('pass' | 'changes')[]): Promise<{ db: DatabaseSync, gitHub: FakeGitHub, tick: () => void, worker: ReviewWorker, notes: [number, string][] }> {
    const { db, gitHub, clock, tick } = setUp()
    const notes: [number, string][] = []
    let round = 0
    const worker = new ReviewWorker({
      isolation: sandboxed,
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(pr)!.review = status.state
      },
      reviewer: async () => {
        round += 1
        const verdict = verdicts[round - 1]!
        return { verdict, findings: verdict === 'changes' ? [`a.ts:${round} the finding of round ${round}`, `b.ts:${round} the second finding of round ${round}`] : [], session: `reviewer-${round}` }
      },
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
      notePr: (number, line) => {
        notes.push([number, line])
        gitHub.pulls.get(number)!.body = `${cardBody(number)}\n\n${line}`
      },
    })
    for (const [at, verdict] of verdicts.entries()) {
      gitHub.open({ number: pr, head: HEADS[at]! })
      tick()
      tick()
      expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict })
      tick()
      tick()
    }
    return { db, gitHub, tick, worker, notes }
  }

  function liveTasksOn(db: DatabaseSync, head: string): string[] {
    return (db.prepare(`SELECT queue FROM tasks WHERE head = ? AND state IN ('queued', 'leased') ORDER BY id`).all(head) as { queue: string }[]).map(row => row.queue)
  }

  function spentEvents(db: DatabaseSync): unknown[] {
    return (db.prepare(`SELECT payload FROM events WHERE type = '${REVIEW_ROUNDS_SPENT}' ORDER BY id`).all() as { payload: string }[]).map(row => JSON.parse(row.payload) as unknown)
  }

  it('after the third changes round no fourth review and no answer are queued for the PR, the merge is blocked, and the bus holds one event with the full list of findings', async () => {
    const { db, gitHub, tick, worker, notes } = await rounds(940, ['changes', 'changes', 'changes'])

    expect(liveTasksOn(db, HEADS[2]!)).toEqual([])
    expect(spentEvents(db)).toEqual([{ state: 'round_limit_reached', pr: 940, rounds: 3, findings: ['a.ts:3 the finding of round 3', 'b.ts:3 the second finding of round 3'] }])
    expect(notes).toEqual([[940, roundLimitLine(940, 3)]])
    expect(gitHub.pulls.get(940)!.body).toBe(`${cardBody(940)}\n\n${roundLimitLine(940, 3)}`)

    gitHub.open({ number: 940, head: HEADS[3]! })
    tick()
    tick()
    expect(liveTasksOn(db, HEADS[3]!)).toEqual([])
    expect(await worker.step()).toEqual({ kind: 'idle' })

    gitHub.open({ number: 940, head: HEADS[3]!, review: 'success' })
    tick()
    tick()
    expect(liveTasksOn(db, HEADS[3]!)).toEqual([])
    expect(spentEvents(db)).toHaveLength(1)
    const live = projectionDump(db)
    reduce(db)
    expect(projectionDump(db)).toBe(live)
    db.close()
  })

  it('a review of the spent PR superseded under its current body is not queued again', async () => {
    const { db, tick } = await rounds(943, ['changes', 'changes', 'changes'])
    const ts = '2026-10-13T12:00:00.000Z'
    const task = { queue: 'review' as const, cardId: 1043, pr: 943, head: HEADS[2]!, input: { prBody: prBodySha(`${cardBody(943)}\n\n${roundLimitLine(943, 3)}`), cardBody: null } }
    expect(queueTask(db, ts, task)).toBe(true)
    expect(supersedeTask(db, ts, task)).toBe(true)
    tick()
    tick()
    expect(tasks(db)).toContainEqual({ task_key: taskKey(task), state: 'superseded' })
    expect(liveTasksOn(db, HEADS[2]!)).toEqual([])
    db.close()
  })

  it('three card-body edits on one head spend no review.rounds_spent', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const worker = new ReviewWorker({
      isolation: sandboxed,
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(944)!.review = status.state
      },
      reviewer: async () => ({ verdict: 'changes', findings: ['a.ts:1 the finding'], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
    })
    gitHub.open({ number: 944, body: cardBody(944) })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })
    for (const edit of [1, 2, 3]) {
      tick()
      importJournal(db, intakeLine(1044, `${edit}123abcd4567ef89`))
      tick()
      expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })
    }

    expect((db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${REVIEW_RECORDED}' AND pr = 944`).get() as { n: number }).n).toBe(4)
    expect(spentEvents(db)).toEqual([])
    db.close()
  })

  it('before the limit a changes verdict is answered as before', async () => {
    const { db, notes } = await rounds(941, ['changes', 'changes'])
    expect(liveTasksOn(db, HEADS[1]!)).toEqual(['answer'])
    expect(spentEvents(db)).toEqual([])
    expect(notes).toEqual([])
    db.close()
  })

  it.each([
    ['the first', ['pass']],
    ['the second', ['changes', 'pass']],
    ['the third', ['changes', 'changes', 'pass']],
  ] as const)('a pass on %s round merges as before', async (_, verdicts) => {
    const { db, notes } = await rounds(942, [...verdicts])
    expect(liveTasksOn(db, HEADS[verdicts.length - 1]!)).toEqual(['merge'])
    expect(spentEvents(db)).toEqual([])
    expect(notes).toEqual([])
    db.close()
  })
})

describe('the card body of the review input is the bodySha the card was last admitted with', () => {
  function admitted(db: DatabaseSync, cardId: number, body: string | null, at: string): void {
    appendEvent(db, { ts: at, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:${at}`, payload: { card: `#${cardId} a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —`, lane: null, ...(body === null ? {} : { bodySha: body }) }, legacy: false })
  }

  it('cardBodyShaOf reads the bodySha of a card admitted after the cutoff', () => {
    const db = openBus(onDisk())
    expect(cardBodyShaOfCard(db, 924)).toBeNull()
    admitted(db, 924, '2203d551cb65', '2026-10-12T19:00:00.000Z')
    admitted(db, 924, null, '2026-10-12T20:00:00.000Z')
    expect(cardBodyShaOfCard(db, 924)).toBe('2203d551cb65')
    db.close()
  })

  it('the later of a legacy intake and a card.admitted gives the card body', () => {
    const db = openBus(onDisk())
    importJournal(db, intakeLine(925, '0123abcd4567ef89'))
    expect(cardBodyShaOfCard(db, 925)).toBe('0123abcd4567ef89')
    admitted(db, 925, 'fedc4567ba98', '2026-10-12T19:00:00.000Z')
    expect(cardBodyShaOfCard(db, 925)).toBe('fedc4567ba98')
    importJournal(db, intakeLine(925, '89ab0123cdef'))
    expect(cardBodyShaOfCard(db, 925)).toBe('89ab0123cdef')
    db.close()
  })
})
