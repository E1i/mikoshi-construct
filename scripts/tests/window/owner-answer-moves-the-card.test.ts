import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STARTED, OWNER_WAIT_CLOSED, REVIEW_RECORDED, WINDOW_REQUEST } from '../../core/events.js'
import { ANSWER_SOURCE } from '../../core/inbox.js'
import { queueTask, supersedeTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { answerCandidates } from '../../nodes/answer/answer-candidates.js'
import { decisionOnAWait, sayToOwnerChannel } from '../../owner/channel.js'
import { decisionsFileOf } from '../../policy/decisions/decisions.js'
import { decisionsAdderOfBus, decisionsSettlerOfBus } from '../../policy/decisions/projection.js'
import { mergeDecidedPastRoundLimit, RECUT_ACTOR } from '../../policy/round-limit-decision.js'
import { answerParts, busProjections } from '../../supervisor/composition.js'
import { DEAD_END } from '../../supervisor/dead-ends.js'
import { runRequest, WindowRequests } from '../../window/window-requests.js'
import { sha } from '../bus/github-fake.js'
import { mergeBench, spendReviewRounds } from '../bus/merge-bench.js'

const PR = 1800
const CARD = PR + 100
const HEAD = sha('c')

interface Room {
  bench: MergeBench
  root: string
  channel: string
}

interface TaskRow {
  queue: string
  pr: number | null
  head: string | null
  task_key: string
  state: string
}

const rooms: Room[] = []

afterEach(() => {
  for (const { bench, root } of rooms.splice(0)) {
    bench.close()
    rmSync(root, { recursive: true, force: true })
  }
})

const ADMISSION = 'owner-answer-moves'
const CARD_LINE = `#${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —`

function emptyRoom(): Room {
  const bench = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'owner-answer-moves-'))
  const made = { bench, root, channel: path.join(root, 'owner-answers') }
  rooms.push(made)
  writeFileSync(decisionsFileOf(bench.busPath), '')
  return made
}

function room(): Room {
  const made = emptyRoom()
  made.bench.gitHub.open({ number: PR, head: HEAD, body: CARD_LINE })
  made.bench.tick()
  return made
}

function roomBeforeAnyPr(): Room {
  const made = emptyRoom()
  appendEvent(made.bench.db, { ts: made.bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${ADMISSION}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: ADMISSION, text: CARD_LINE, textSha: textSha(CARD_LINE) }, legacy: false })
  made.bench.tick()
  return made
}

function refuse(): never {
  throw new Error('an owner answer uses no other tool')
}

function tools(at: Room): RequestTools {
  return { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: decisionsAdderOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now), settleDecisions: decisionsSettlerOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now, busProjections()), causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
}

function changesOn(at: Room, head: string): void {
  appendEvent(at.bench.db, { ts: at.bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:session-1', cardId: CARD, pr: PR, head, dedupeKey: `${REVIEW_RECORDED}:changes-${head}`, payload: { head, verdict: 'changes', reviewer_session: 'session-1', findings: [] }, legacy: false })
}

function roundLimitWait(at: Room, pr = PR): string {
  const text = `PR #${pr} of card #${CARD} reached the review round limit (D-104) and was not re-cut: the owner decides`
  const wait = openBusWait(at.bench.db, at.bench.clock.now().toISOString(), RECUT_ACTOR, { need: 'decision', text, card: CARD, pr })
  reduce(at.bench.db, 'pending', busProjections())
  return wait
}

function mergeWait(at: Room): string {
  const wait = openBusWait(at.bench.db, at.bench.clock.now().toISOString(), 'worker:merge:s1', { need: 'merge', text: 'policy.denied: a new node:child_process import', card: CARD, pr: PR })
  reduce(at.bench.db, 'pending', busProjections())
  return wait
}

function sessionRuns(at: Room): void {
  expect(supersedeTask(at.bench.db, at.bench.clock.now().toISOString(), { queue: 'launch', cardId: CARD, generation: ADMISSION })).toBe(true)
  appendEvent(at.bench.db, { ts: at.bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:node-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:owner-answer-moves`, payload: { session: 'card-session', worktree: `/trees/mc-${CARD}`, branch: `feat/card-${CARD}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap' }, legacy: false })
  reduce(at.bench.db, 'pending', busProjections())
}

function launchQueuedAlready(at: Room): void {
  expect(queueTask(at.bench.db, at.bench.clock.now().toISOString(), { queue: 'launch', cardId: CARD, generation: 'earlier' })).toBe(true)
  reduce(at.bench.db, 'pending', busProjections())
}

function prClosed(at: Room): void {
  at.bench.gitHub.close(PR, false)
  at.bench.tick()
}

function lastRequest(at: Room): number {
  return Number((at.bench.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(WINDOW_REQUEST) as { id: number }).id)
}

function ownerAnswers(at: Room, wait: string, answer: string): { kind: string, detail: string } {
  sayToOwnerChannel(at.channel, decisionOnAWait(wait, answer), at.bench.clock.now())
  expect(runRequest(['owner.wait.close', '--id', wait, '--from', ANSWER_SOURCE], at.bench.db, at.bench.clock.now(), 'test', () => {})).toBe(0)
  const [outcome] = new WindowRequests(at.bench.db, at.bench.clock.now, tools(at), at.channel, () => null, process.cwd(), at.bench.gitHub.client).run()
  reduce(at.bench.db, 'pending', busProjections())
  return outcome!
}

function tasksOf(at: Room, queue: string): TaskRow[] {
  return at.bench.db.prepare('SELECT queue, pr, head, task_key, state FROM tasks WHERE queue = ? AND card_id = ?').all(queue, CARD) as unknown as TaskRow[]
}

function answersPlanned(at: Room): number {
  return answerCandidates(at.bench.db, at.bench.clock.now().toISOString(), answerParts()).filter(task => task.cardId === CARD).length
}

function eventIds(at: Room, type: string): { id: number, payload: Record<string, unknown> }[] {
  return (at.bench.db.prepare('SELECT id, payload FROM events WHERE type = ? ORDER BY id').all(type) as { id: number, payload: string }[])
    .map(row => ({ id: Number(row.id), payload: JSON.parse(row.payload) as Record<string, unknown> }))
}

describe('an owner answer that names a node action moves the card in the same close', () => {
  it('an owner answer merge on a round-limit wait past the limit queues the merge task and no answer task', () => {
    const at = room()
    spendReviewRounds(at.bench, PR, HEAD)
    const wait = roundLimitWait(at)

    const outcome = ownerAnswers(at, wait, 'merge')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, 'merge'), outcome.detail).toEqual([expect.objectContaining({ pr: PR, head: HEAD, state: 'queued', task_key: expect.stringMatching(/:decision-[1-9]\d*$/) })])
    expect(mergeDecidedPastRoundLimit(at.bench.db, at.bench.clock.now().toISOString(), PR, HEAD)).not.toBeNull()
    expect(answersPlanned(at)).toBe(0)
    expect(tasksOf(at, 'answer')).toEqual([])
  })

  it('an owner answer merge on a merge wait queues the merge, not an answer round', () => {
    const at = room()
    const wait = mergeWait(at)

    const outcome = ownerAnswers(at, wait, 'merge')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, 'merge'), outcome.detail).toEqual([expect.objectContaining({ pr: PR, head: HEAD, state: 'queued' })])
    expect(tasksOf(at, 'answer')).toEqual([])
  })

  it('an owner answer naming review queues a review task on the current PR head after a changes verdict', () => {
    const at = room()
    changesOn(at, HEAD)
    const wait = roundLimitWait(at)

    const outcome = ownerAnswers(at, wait, 'review the current head')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, 'review'), outcome.detail).toEqual([expect.objectContaining({ pr: PR, head: HEAD, state: 'queued' })])
    expect(outcome.detail).toContain(`the review task on PR #${PR} at ${HEAD}`)
  })

  it('an owner answer naming no node action on a card with no live task raises the dead end at once', () => {
    const at = room()
    const wait = roundLimitWait(at)

    const outcome = ownerAnswers(at, wait, 'not now, I will think about it')

    expect(outcome.kind, outcome.detail).toBe('done')
    const closed = eventIds(at, OWNER_WAIT_CLOSED)
    const alarms = eventIds(at, BOARD_ALARM)
    expect(alarms, outcome.detail).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: DEAD_END }) })])
    expect(closed).toHaveLength(1)
    expect(alarms[0]!.id).toBe(closed[0]!.id + 1)
  })

  it('an owner answer continue on a merge wait queues the answer round carrying the decision', () => {
    const at = room()
    const wait = mergeWait(at)

    const outcome = ownerAnswers(at, wait, 'continue: rework the PR without the new import')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, 'answer'), outcome.detail).toEqual([expect.objectContaining({ pr: PR, head: HEAD, state: 'queued', task_key: expect.stringMatching(/:decision-[1-9]\d*$/) })])
    expect(tasksOf(at, 'merge')).toEqual([])
  })
})

describe('an owner answer naming launch queues one launch task of the owner generation', () => {
  it('an owner answer launch on a card with no session queues the launch task named after the request', () => {
    const at = room()
    const wait = roundLimitWait(at)

    const outcome = ownerAnswers(at, wait, 'launch it again')

    const generation = `owner-${lastRequest(at)}`
    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, 'launch'), outcome.detail).toEqual([expect.objectContaining({ state: 'queued', task_key: expect.stringContaining(generation) })])
    expect(outcome.detail).toContain(`launch:${CARD}:${generation}`)
  })

  it('an owner answer launch on a card whose session runs queues no launch task', () => {
    const at = roomBeforeAnyPr()
    sessionRuns(at)
    const wait = roundLimitWait(at)

    const outcome = ownerAnswers(at, wait, 'launch it again')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, 'launch').filter(task => task.state === 'queued'), outcome.detail).toEqual([])
    expect(outcome.detail).toContain(`card #${CARD} runs the session started at event`)
  })

  it('an owner answer launch on a card with a launch task queued already queues no second one', () => {
    const at = room()
    launchQueuedAlready(at)
    const wait = roundLimitWait(at)

    const outcome = ownerAnswers(at, wait, 'launch it again')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, 'launch'), outcome.detail).toEqual([expect.objectContaining({ state: 'queued', task_key: expect.stringContaining('earlier') })])
    expect(outcome.detail).toContain(`card #${CARD} has a launch task queued already`)
  })
})

describe('an owner answer naming merge or review on a PR that cannot take it queues nothing', () => {
  it.each([
    ['merge', 'merge'],
    ['review the current head', 'review'],
  ])('an owner answer %s on a closed PR queues no %s task', (answer, queue) => {
    const at = room()
    const wait = roundLimitWait(at)
    prClosed(at)

    const outcome = ownerAnswers(at, wait, answer)

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, queue), outcome.detail).toEqual([])
    expect(outcome.detail).toContain(`PR #${PR} is closed, so no ${queue} task is queued`)
  })

  it.each([
    ['merge', 'merge'],
    ['review the current head', 'review'],
  ])('an owner answer %s on a PR the bus never observed queues no %s task and raises the dead end', (answer, queue) => {
    const at = room()
    const unseen = PR + 1
    const wait = roundLimitWait(at, unseen)

    const outcome = ownerAnswers(at, wait, answer)

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(tasksOf(at, queue), outcome.detail).toEqual([])
    expect(outcome.detail).toContain(`PR #${unseen} is not observed, so no ${queue} task is queued`)
    expect(eventIds(at, BOARD_ALARM)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: DEAD_END }) })])
  })
})

describe('an owner answer naming no node action raises no dead end where the card still moves', () => {
  it.each([
    ['a merge wait', (at: Room) => mergeWait(at)],
    ['a card with a queued task', (at: Room) => {
      launchQueuedAlready(at)
      return roundLimitWait(at)
    }],
  ])('an owner answer naming no node action on %s raises no dead end', (_, waitOf) => {
    const at = room()
    const wait = waitOf(at)

    const outcome = ownerAnswers(at, wait, 'not now, I will think about it')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(eventIds(at, OWNER_WAIT_CLOSED)).toHaveLength(1)
    expect(eventIds(at, BOARD_ALARM), outcome.detail).toEqual([])
  })

  it('an owner answer naming no node action on a card whose session runs raises no dead end', () => {
    const at = roomBeforeAnyPr()
    sessionRuns(at)
    const wait = roundLimitWait(at)

    const outcome = ownerAnswers(at, wait, 'not now, I will think about it')

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(eventIds(at, OWNER_WAIT_CLOSED)).toHaveLength(1)
    expect(eventIds(at, BOARD_ALARM), outcome.detail).toEqual([])
  })
})
