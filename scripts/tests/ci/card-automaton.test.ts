import type { CardAutomaton, CardCondition, ConditionSelection, NodeCandidates } from '../../ci/card-automaton.js'
import type { BusEvent } from '../../core/db.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { automatonFindings, conditionKey, selectingNodes } from '../../ci/card-automaton.js'
import * as cards from '../../core/card-automaton.js'
import { appendEvent, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DEFERRED, CARD_FELL, CARD_STARTED, CARD_STOPPED, GHOST_ROW, QUESTION_OWNER, REVIEW_RECORDED } from '../../core/events.js'
import { completeTask, leaseNext } from '../../core/lease.js'
import { cardBodyShaOfCard, queueTask, reviewCandidates } from '../../core/queue.js'
import { candidateRules, cardAutomaton, cardTransitions, namedQueueSources, nodeCandidates, queuePass, queueSources } from '../../supervisor/composition.js'
import { cardBody } from '../bus/github-fake.js'
import { cardVerified, mergeBench } from '../bus/merge-bench.js'

const SYNTHETIC: CardAutomaton = {
  states: ['queued', 'running', 'limbo', 'closed'],
  ends: ['closed'],
  conditions: [{ state: 'queued', condition: 'admitted' }, { state: 'running', condition: 'session live' }, { state: 'limbo', condition: 'nobody looks' }],
}

const SYNTHETIC_SELECTIONS: ConditionSelection[] = [
  { state: 'queued', condition: 'admitted', nodes: ['launch'] },
  { state: 'running', condition: 'session live', nodes: ['launch'] },
  { state: 'limbo', condition: 'nobody looks', nodes: [] },
]

const PR = 41
const CARD = PR + 100

type Placed = (bench: MergeBench) => number

function event(bench: MergeBench, type: string, cardId: number, payload: Record<string, unknown>, pr: number | null = null): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type, actor: 'worker:fixture:automaton', cardId, pr, head: null, dedupeKey: `${type}:fixture:${cardId}:${bench.clock.now().getTime()}`, payload, legacy: false })
  bench.tick()
}

function admitted(bench: MergeBench, cardId = CARD, contour = 'cheap'): number {
  const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nMove it.\n`
  event(bench, CARD_ADMITTED, cardId, { card: `#${cardId}`, lane: 'lane-1', contour, text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) })
  return cardId
}

function launched(bench: MergeBench, outcome: (actor: string) => BusEvent[]): void {
  const ts = bench.clock.now().toISOString()
  const actor = 'worker:launch:fixture'
  const lease = leaseNext(bench.db, ts, 'launch', actor)!
  completeTask(bench.db, cardTransitions(), ts, lease, outcome(actor))
  bench.tick()
}

const SESSION_PID = 4242

function startEvent(bench: MergeBench, actor: string, pid: number | null): BusEvent {
  return { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:fixture:${CARD}`, payload: { worktree: `/trees/${CARD}`, branch: `feat/card-${CARD}`, session: 'fixture-session', ...(pid === null ? {} : { pid }) }, legacy: false }
}

function started(bench: MergeBench, contour = 'cheap'): number {
  admitted(bench, CARD, contour)
  launched(bench, actor => [startEvent(bench, actor, SESSION_PID)])
  return CARD
}

function launchLeasedWithItsSessionLive(bench: MergeBench): number {
  admitted(bench)
  const ts = bench.clock.now().toISOString()
  const lease = leaseNext(bench.db, ts, 'launch', 'worker:launch:fixture')!
  appendEvent(bench.db, startEvent(bench, lease.actor, SESSION_PID))
  bench.tick()
  return CARD
}

function startedByHand(bench: MergeBench): number {
  admitted(bench)
  launched(bench, () => [])
  appendEvent(bench.db, startEvent(bench, 'worker:window:takeover', null))
  bench.tick()
  return CARD
}

function opened(bench: MergeBench, pull: Parameters<MergeBench['gitHub']['open']>[0]): number {
  started(bench)
  bench.gitHub.open({ body: cardBody(PR), ref: `feat/card-${CARD}`, ...pull })
  bench.tick()
  return CARD
}

function verdict(bench: MergeBench, said: 'pass' | 'changes'): void {
  const ts = bench.clock.now().toISOString()
  for (const task of reviewCandidates(bench.db, ts, candidateRules()).filter(task => task.cardId === CARD))
    queueTask(bench.db, ts, task)
  const actor = 'worker:review:fixture'
  const lease = leaseNext(bench.db, ts, 'review', actor)!
  completeTask(bench.db, cardTransitions(), ts, lease, [{ ts, type: REVIEW_RECORDED, actor, cardId: CARD, pr: PR, head: lease.head, dedupeKey: `${REVIEW_RECORDED}:fixture:${said}`, payload: { head: lease.head, verdict: said, card_body: cardBodyShaOfCard(bench.db, CARD), reviewer_session: 'fixture', findings: said === 'pass' ? [] : ['a defect'] }, legacy: false }])
  bench.gitHub.open({ ...bench.gitHub.pulls.get(PR)!, review: said === 'pass' ? 'success' : 'failure' })
  bench.tick()
}

function reviewed(said: 'pass' | 'changes', verified: boolean): Placed {
  return (bench) => {
    opened(bench, { number: PR })
    if (verified)
      cardVerified(bench.db, bench.clock.now().toISOString(), CARD, PR)
    verdict(bench, said)
    return CARD
  }
}

function stoppedOn(reason: string): Placed {
  return (bench) => {
    started(bench)
    event(bench, CARD_STOPPED, CARD, { reason, detail: `a ${reason} on card #${CARD}` })
    if (reason === QUESTION_OWNER)
      openOwnerWait(bench.db, bench.clock.now().toISOString(), 'worker:fixture:automaton', { need: 'decision', text: `card #${CARD} asks`, card: CARD })
    return CARD
  }
}

const CONDITION_FIXTURES: Record<string, Placed> = {
  'queued/admitted': bench => admitted(bench),
  'running/session launched': launchLeasedWithItsSessionLive,
  'running/session started by hand': startedByHand,
  'in_review/pull request open': bench => opened(bench, { number: PR }),
  'in_review/ci red': bench => opened(bench, { number: PR, required: 'failure', failed: ['lint'] }),
  'changes/verdict changes': reviewed('changes', false),
  'ready/verdict pass': reviewed('pass', true),
  'merged/pull request merged': (bench) => {
    reviewed('pass', true)(bench)
    bench.gitHub.close(PR, true)
    bench.tick()
    return CARD
  },
  'fallen/fell': (bench) => {
    started(bench, 'ladder')
    event(bench, CARD_FELL, CARD, { kind: 'died' })
    event(bench, GHOST_ROW, CARD, { state: 'free' })
    return CARD
  },
  'deferred/deferred by the owner': (bench) => {
    admitted(bench)
    event(bench, CARD_DEFERRED, CARD, { reason: 'later' })
    return CARD
  },
  'stopped/stopped on an owner question': stoppedOn(QUESTION_OWNER),
  'stopped/stopped on an agent question': stoppedOn('question.agent'),
}

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

function stateOf(bench: MergeBench, cardId: number): string | null {
  return (bench.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined)?.state ?? null
}

function placedOnABus(key: string): { bench: MergeBench, card: number } {
  const bench = mergeBench()
  benches.push(bench)
  const card = CONDITION_FIXTURES[key]!(bench)
  return { bench, card }
}

function liveTaskQueues(bench: MergeBench, card: number): string[] {
  return (bench.db.prepare(`SELECT DISTINCT queue FROM tasks WHERE card_id = ? AND state IN ('queued', 'leased') ORDER BY queue`).all(card) as { queue: string }[]).map(row => row.queue)
}

interface PlacedCondition {
  condition: CardCondition
  bench: MergeBench
  card: number
}

function everyConditionPlaced(): PlacedCondition[] {
  return cardAutomaton().conditions.map(condition => ({ condition, ...placedOnABus(conditionKey(condition)) }))
}

function selectionsOn(placed: readonly PlacedCondition[], candidates: readonly NodeCandidates[], heldByALiveTask: boolean): ConditionSelection[] {
  return placed.map(({ condition, bench, card }) => {
    const selecting = selectingNodes(bench.db, bench.clock.now().toISOString(), candidates, card)
    return { ...condition, nodes: [...new Set([...selecting, ...(heldByALiveTask ? liveTaskQueues(bench, card) : [])])] }
  })
}

function cardStatesOfTheAutomaton(): string[] {
  return Object.entries(cards).filter(([name, value]) => name.endsWith('_CARD') && typeof value === 'string').map(([, value]) => value as string)
}

describe('the automaton check fails on a synthetic state no node selects', () => {
  it('a reachable condition whose bus no node\'s candidates select is a dead end', () => {
    expect(automatonFindings(SYNTHETIC, SYNTHETIC_SELECTIONS)).toEqual([`dead end limbo/nobody looks: no node's queue candidates select a limbo card on nobody looks`])
  })

  it('a state in work with no condition at all fails the check', () => {
    const silent = { ...SYNTHETIC, states: [...SYNTHETIC.states, 'void'] }
    expect(automatonFindings(silent, SYNTHETIC_SELECTIONS.map(each => ({ ...each, nodes: ['launch'] })))).toEqual(['card state void is reachable and names no condition, so no node can be shown to select it'])
  })

  it('a condition never placed on a bus fails the check', () => {
    expect(automatonFindings(SYNTHETIC, SYNTHETIC_SELECTIONS.slice(0, 2))).toEqual([`card condition limbo/nobody looks was not placed on a bus, so no node's candidates were asked`])
  })

  it('an end state needs no mover', () => {
    expect(automatonFindings({ ...SYNTHETIC, conditions: [...SYNTHETIC.conditions, { state: 'closed', condition: 'merged and closed' }] }, SYNTHETIC_SELECTIONS.map(each => ({ ...each, nodes: ['launch'] })))).toEqual([])
  })
})

describe('every reachable card state on main has a mover', () => {
  it('the composed automaton names every state the card folds can reach', () => {
    expect([...cardAutomaton().states].sort()).toEqual(cardStatesOfTheAutomaton().sort())
  })

  it('every condition has one fixture, and each fixture places its card in the condition\'s state', () => {
    expect(Object.keys(CONDITION_FIXTURES).sort()).toEqual(cardAutomaton().conditions.map(conditionKey).sort())
    for (const condition of cardAutomaton().conditions) {
      const { bench, card } = placedOnABus(conditionKey(condition))
      expect(stateOf(bench, card), conditionKey(condition)).toBe(condition.state)
    }
  })

  it('every condition of every state in work is selected by the candidates of some node, or held by a live task they queued', () => {
    expect(automatonFindings(cardAutomaton(), selectionsOn(everyConditionPlaced(), nodeCandidates(), true))).toEqual([])
  })

  it('a node that alone selects a condition is load-bearing: leave its candidates out and the check names the dead end', () => {
    const placed = everyConditionPlaced()
    const selections = selectionsOn(placed, nodeCandidates(), false)
    const soleMovers = [...new Set(selections.filter(each => each.nodes.length === 1).map(each => each.nodes[0]!))]
    expect(soleMovers).toEqual(expect.arrayContaining(['answer', 'review', 'close', 'owner', 'supervisor']))
    for (const node of soleMovers) {
      const without = nodeCandidates().filter(each => each.node !== node)
      const orphaned = selections.filter(each => each.nodes.length === 1 && each.nodes[0] === node).map(each => `dead end ${conditionKey(each)}: no node's queue candidates select a ${each.state} card on ${each.condition}`)
      expect(automatonFindings(cardAutomaton(), selectionsOn(placed, without, false)), node).toEqual(expect.arrayContaining(orphaned))
    }
  })

  it('a queue source dropped from the list deriveQueues runs is dropped from the check: the restart source alone is the restart node', () => {
    const named = namedQueueSources()
    expect(nodeCandidates(named).filter(each => each.node === 'restart')).toHaveLength(1)
    expect(nodeCandidates(named.filter(each => each.node !== 'restart')).filter(each => each.node === 'restart')).toEqual([])
  })

  it('the sources the check reads are the sources deriveQueues runs, one for one and in order', () => {
    const named = namedQueueSources()
    expect(queueSources().map(source => source.queue ?? null)).toEqual(named.map(each => each.source.queue ?? null))
    expect(queuePass().sources.map(source => Object.keys(source).sort())).toEqual(named.map(each => Object.keys(each.source).sort()))
  })
})
