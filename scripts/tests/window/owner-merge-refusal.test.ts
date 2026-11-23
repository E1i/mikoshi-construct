import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { closedWaitIds } from '../../core/card-readings.js'
import { openBusWait } from '../../core/db.js'
import { ANSWER_SOURCE } from '../../core/inbox.js'
import { reduce } from '../../core/reducer.js'
import { decisionOnAWait, sayToOwnerChannel } from '../../owner/channel.js'
import { decisionsFileOf } from '../../policy/decisions/decisions.js'
import { decisionsAdderOfBus, decisionsSettlerOfBus } from '../../policy/decisions/projection.js'
import { decisionsInForceAt } from '../../policy/shards.js'
import { busProjections } from '../../supervisor/composition.js'
import { runRequest, WindowRequests } from '../../window/window-requests.js'
import { sha } from '../bus/github-fake.js'
import { liveBench } from '../bus/merge-bench.js'

const CARD = 1943
const PR = 1717
const HEAD = sha('c')
const REFUSAL = 'not in this form; an answer round reworks the PR without the new child_process import'

interface Room {
  bench: MergeBench
  root: string
  channel: string
}

interface AnswerTask {
  card_id: number
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

function room(): Room {
  const bench = liveBench()
  const root = mkdtempSync(path.join(tmpdir(), 'owner-merge-refusal-'))
  const made = { bench, root, channel: path.join(root, 'owner-answers') }
  rooms.push(made)
  writeFileSync(decisionsFileOf(bench.busPath), '')
  bench.gitHub.open({ number: PR, head: HEAD, body: `#${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —` })
  bench.tick()
  return made
}

function refuse(): never {
  throw new Error('closing a merge wait uses no other tool')
}

function tools(at: Room): RequestTools {
  return { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: decisionsAdderOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now), settleDecisions: decisionsSettlerOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now, busProjections()), causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
}

function mergeWait(at: Room): string {
  const wait = openBusWait(at.bench.db, closedWaitIds(at.bench.db), at.bench.clock.now().toISOString(), 'worker:merge:s1', { need: 'merge', text: 'policy.denied: a new node:child_process import', card: CARD, pr: PR })
  reduce(at.bench.db, 'pending', busProjections())
  return wait
}

function ownerCloses(at: Room, wait: string, answer: string): { kind: string, detail: string } {
  sayToOwnerChannel(at.channel, decisionOnAWait(wait, answer), at.bench.clock.now())
  expect(runRequest(['owner.wait.close', '--id', wait, '--from', ANSWER_SOURCE], at.bench.db, at.bench.clock.now(), 'test', () => {})).toBe(0)
  const [outcome] = new WindowRequests(at.bench.db, at.bench.clock.now, tools(at), at.channel, () => null, process.cwd(), at.bench.gitHub.client).run()
  reduce(at.bench.db, 'pending', busProjections())
  return outcome!
}

function answerTasks(at: Room): AnswerTask[] {
  return at.bench.db.prepare(`SELECT card_id, pr, head, task_key, state FROM tasks WHERE queue = 'answer' AND card_id = ?`).all(CARD) as unknown as AnswerTask[]
}

function waitState(at: Room, wait: string): string {
  return (at.bench.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(wait) as { state: string }).state
}

describe('an owner\'s refusal of a merge reaches an answer round', () => {
  it('a need merge wait closed with a refusal queues an answer task carrying the answer', () => {
    const at = room()
    const wait = mergeWait(at)

    const outcome = ownerCloses(at, wait, REFUSAL)

    expect(outcome.kind, outcome.detail).toBe('done')
    expect(waitState(at, wait)).toBe('closed')
    const tasks = answerTasks(at)
    expect(tasks, outcome.detail).toEqual([expect.objectContaining({ card_id: CARD, pr: PR, head: HEAD, state: 'queued' })])
    expect(tasks[0]!.task_key).toMatch(/:decision-[1-9]\d*$/)
    expect(outcome.detail).toContain(`the answer round on PR #${PR} at ${HEAD}`)
  })

  it('the decision the answer task names carries the owner\'s answer bound to the card', () => {
    const at = room()
    const wait = mergeWait(at)

    ownerCloses(at, wait, REFUSAL)

    const decision = Number(/:decision-(\d+)$/.exec(answerTasks(at)[0]!.task_key)![1])
    const recorded = decisionsInForceAt(at.bench.db, at.bench.clock.now()).find(each => each.decisionId === decision)
    expect(recorded?.text).toContain(REFUSAL)
    expect(recorded?.cards).toEqual([CARD])
  })

  it('closing the same refusal again queues no second answer round', () => {
    const at = room()
    const wait = mergeWait(at)
    ownerCloses(at, wait, REFUSAL)

    expect(ownerCloses(at, wait, REFUSAL).kind).toBe('refused')
    expect(answerTasks(at)).toHaveLength(1)
  })

  it('a merge wait the bus closed with its PR is closed already and queues no answer round', () => {
    const at = room()
    const wait = mergeWait(at)
    at.bench.gitHub.close(PR, false)
    at.bench.tick()
    reduce(at.bench.db, 'pending', busProjections())

    expect(ownerCloses(at, wait, REFUSAL)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('is closed already') })
    expect(answerTasks(at)).toEqual([])
  })

  it('a decision wait on the same card queues no answer round of its own', () => {
    const at = room()
    const wait = openBusWait(at.bench.db, closedWaitIds(at.bench.db), at.bench.clock.now().toISOString(), 'policy', { need: 'decision', text: 'which path?', card: CARD, pr: PR })
    reduce(at.bench.db, 'pending', busProjections())

    expect(ownerCloses(at, wait, 'take the second path').kind).toBe('done')
    expect(answerTasks(at)).toEqual([])
  })
})
