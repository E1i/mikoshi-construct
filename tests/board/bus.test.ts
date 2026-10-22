import type { BusFacts, BusReading } from '../../src/commands/board/bus.js'
import type { BusSeed, SeedCard, SeedEvent } from './bus-fixture.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROCESS_HEARTBEAT } from '../../scripts/core/events.js'
import { busReaderAt, SESSION_SHOWN_MINUTES, SUBAGENT_SHOWN_HOURS } from '../../src/commands/board/bus.js'
import { GOAL_DECISION } from '../../src/commands/board/goal.js'
import { flowLines } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'
import { checkMatrix, subagent, writeBus } from './bus-fixture.js'

const NOW = new Date('2026-10-02T12:00:00.000Z')
const HOUR = 3_600_000

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString()
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-board-bus-'))
}

function read(seed: BusSeed): BusReading {
  return busReaderAt(writeBus(path.join(scratch(), 'bus.db'), seed), () => NOW)()
}

function facts(seed: BusSeed): BusFacts {
  const reading = read(seed)
  if (reading.status !== 'read')
    throw new Error(`the bus was ${reading.status}`)
  return reading.facts
}

describe('the board bus reader', () => {
  it('the goal is the D-193 release over the cards whose Path line names it, merged of all but the dropped', () => {
    const path = (state: string, line: string): { state: string, text: string } => ({ state, text: `do it\n\nPath (D-76): ${line}\n` })
    const cards = [path('merged', 'cheap — 0.44, slice S'), path('queued', 'cheap — 0.44 night order'), path('dropped', 'cheap — 0.44'), path('merged', 'cheap — 0.45')]
      .map((card, index) => ({ id: 10 + index, lane: null, line: null, ...card }))
    expect(facts({ cards }).goal).toBeNull()
    expect(facts({ cards, decisions: [[GOAL_DECISION, '[owner] 0.44 scope is the list']] }).goal).toEqual({ release: '0.44', done: 1, total: 2 })
  })

  it('reads every card with its state, lane and card line, in card order', () => {
    expect(facts({ cards: [{ id: 2, state: 'changes', lane: null, line: null }, { id: 1, state: 'queued', lane: 'a', line: 'card: #1 alpha' }] }).cards).toEqual([
      { id: 1, state: 'queued', stage: 'planned', lane: 'a', line: 'card: #1 alpha', since: null, body: true, closed: false, closedAt: null },
      { id: 2, state: 'changes', stage: 'answer/changes', lane: null, line: null, since: null, body: true, closed: false, closedAt: null },
    ])
  })

  it('the stage of every live card matches its task in the bus queue', () => {
    const card = (id: number, state: string): SeedCard => ({ id, state, lane: null, line: null })
    const read = facts({
      cards: [card(1, 'running'), card(2, 'running'), card(3, 'in_review'), card(4, 'running'), card(5, 'queued'), card(6, 'merged'), card(7, 'stopped'), card(8, 'dropped'), card(9, 'closed'), card(10, 'running')],
      tasks: [
        { queue: 'review', card: 1, pr: null, head: null, state: 'queued' },
        { queue: 'answer', card: 3, pr: null, head: null, state: 'leased' },
        { queue: 'merge', card: 4, pr: null, head: null, state: 'leased' },
        { queue: 'review', card: 4, pr: null, head: null, state: 'completed' },
        { queue: 'launch', card: 5, pr: null, head: null, state: 'queued' },
        { queue: 'answer', card: 7, pr: null, head: null, state: 'queued' },
      ],
      events: [{ ts: ago(HOUR), type: 'card.verified', card: 10, payload: '{}' }],
    })
    expect(read.cards.map(each => [each.id, each.stage])).toEqual([
      [1, 'review'],
      [2, 'in work'],
      [3, 'answer/changes'],
      [4, 'ready'],
      [5, 'planned'],
      [6, 'merged'],
      [7, 'stopped'],
      [8, 'dropped'],
      [9, 'dropped'],
      [10, 'merged'],
    ])
  })

  it('the goal bar counts sum to the number of plan cards', () => {
    const plan = (id: number, state: string, release = '0.44'): SeedCard => ({ id, state, lane: null, line: null, text: `do it\n\nPath (D-76): cheap — ${release}\n` })
    const read = facts({
      cards: [plan(1, 'merged'), plan(2, 'running'), plan(3, 'running'), plan(4, 'queued'), plan(5, 'dropped'), plan(6, 'stopped'), plan(7, 'merged', '0.45'), { id: 8, state: 'running', lane: null, line: null }],
      tasks: [{ queue: 'review', card: 3, pr: null, head: null, state: 'leased' }],
      decisions: [[GOAL_DECISION, '[owner] 0.44 scope is the list']],
    })
    expect(read.plan).toEqual([
      { stage: 'planned', cards: [4] },
      { stage: 'in work', cards: [2] },
      { stage: 'review', cards: [3] },
      { stage: 'answer/changes', cards: [] },
      { stage: 'ready', cards: [] },
      { stage: 'merged', cards: [1] },
      { stage: 'stopped', cards: [6] },
      { stage: 'dropped', cards: [5] },
    ])
    const counted = read.plan!.reduce((sum, stage) => sum + stage.cards.length, 0)
    expect(counted).toBe(6)
    expect(counted - read.plan!.find(stage => stage.stage === 'dropped')!.cards.length).toBe(read.goal!.total)
    expect(facts({ cards: [plan(1, 'merged')] }).plan).toBeNull()
  })

  it('with no open owner question the waits-for-you fact is empty', () => {
    expect(facts({}).waits).toEqual([])
    const answered = facts({
      cards: [{ id: 1, state: 'stopped', lane: null, line: null }, { id: 2, state: 'running', lane: null, line: null }, { id: 3, state: 'stopped', lane: null, line: null }],
      prs: [{ pr: 30, card: 3, state: 'merged' }],
      events: [
        { ts: ago(3 * HOUR), type: 'card.stopped', card: 1, payload: JSON.stringify({ reason: 'question.owner', detail: 'which path?' }) },
        { ts: ago(2 * HOUR), type: 'card.stopped', card: 2, payload: JSON.stringify({ reason: 'question.owner', detail: 'answered by its restart' }) },
        { ts: ago(2 * HOUR), type: 'card.stopped', card: 3, payload: JSON.stringify({ reason: 'fault' }) },
        { ts: ago(HOUR), type: 'policy.denied', card: 3, pr: 30, payload: JSON.stringify({ kind: 'authority', detail: 'the owner merges' }) },
      ],
      decisions: [[900, '[owner] take the first path', [1]]],
    })
    expect(answered.waits).toEqual([])
  })

  it('an open owner question, an owner-kind denial on an open PR and the version PR wait for the owner', () => {
    const read = facts({
      cards: [{ id: 1, state: 'stopped', lane: null, line: null }, { id: 2, state: 'in_review', lane: null, line: null }],
      prs: [{ pr: 20, card: 2, state: 'open' }, { pr: 669, card: null, state: 'open' }, { pr: 600, card: null, state: 'merged' }],
      events: [
        { ts: ago(3 * HOUR), type: 'card.stopped', card: 1, payload: JSON.stringify({ reason: 'question.owner', detail: 'which path?' }) },
        { ts: ago(2 * HOUR), type: 'policy.denied', card: 2, pr: 20, payload: JSON.stringify({ kind: 'authority', detail: 'first' }) },
        { ts: ago(HOUR), type: 'policy.denied', card: 2, pr: 20, payload: JSON.stringify({ kind: 'authority', detail: 'changes architecture/security-invariants.md' }) },
        { ts: ago(HOUR), type: 'policy.denied', card: 2, pr: 20, legacy: true, payload: JSON.stringify({ kind: 'authority', detail: 'legacy' }) },
      ],
      decisions: [[900, '[owner] about another card', [7]]],
    })
    expect(read.waits).toEqual([
      { kind: 'question', card: 1, pr: null, detail: 'which path?', since: ago(3 * HOUR) },
      { kind: 'decision', card: 2, pr: 20, detail: 'changes architecture/security-invariants.md', since: ago(HOUR) },
      { kind: 'version', card: null, pr: 669, detail: null, since: null },
    ])
  })

  it('a merged or closed card has no session tile, whatever its last pulse', () => {
    const beat = (card: number): SeedEvent => ({ ts: ago(60_000), type: 'session.heartbeat', card, payload: JSON.stringify({ session: `s${card}`, step: 'launch' }) })
    const services = facts({
      cards: [{ id: 1, state: 'running', lane: null, line: null }, { id: 2, state: 'merged', lane: null, line: null }, { id: 3, state: 'closed', lane: null, line: null }, { id: 4, state: 'running', lane: null, line: null }],
      events: [beat(1), beat(2), beat(3), beat(4), { ts: ago(HOUR), type: 'card.verified', card: 4, payload: '{}' }],
    }).services
    expect(services.map(service => service.task)).toEqual(['#1'])
  })

  it('a card that moved from launch to review has no launch tile', () => {
    const beat = (card: number, step: string, minutes: number): SeedEvent => ({ ts: ago(minutes * 60_000), type: 'session.heartbeat', card, payload: JSON.stringify({ session: `s${card}`, step }) })
    const card = (id: number, state: string): SeedCard => ({ id, state, lane: null, line: null })
    const services = facts({
      cards: [card(1196, 'in_review'), card(1194, 'queued'), card(1, 'running'), card(2, 'in_review'), card(3, 'running'), card(4, 'running')],
      tasks: [{ queue: 'review', card: 2, pr: null, head: null, state: 'queued' }],
      events: [beat(1196, 'launch', 4), beat(1194, 'launch', 1), beat(1, 'launch', 1), beat(2, 'review', 1), beat(3, 'session', 1), beat(4, 'launch', SESSION_SHOWN_MINUTES + 1)],
    }).services
    expect(services.map(service => service.task)).toEqual(['#1', '#2', '#3'])
  })

  it('a card with no card body, or closed through task:close, is not in Flow, and a session death is the last failure', () => {
    const read = facts({
      cards: [{ id: 170, state: 'queued', lane: null, line: null, body: false }, { id: 1068, state: 'running', lane: null, line: null }, { id: 1071, state: 'running', lane: null, line: null }],
      events: [
        { ts: ago(2 * HOUR), type: 'card.verified', card: 1068, payload: JSON.stringify({ sharedBy: 'D-189' }) },
        { ts: ago(3 * HOUR), type: 'card.fell', card: 7, payload: '{}' },
        { ts: ago(HOUR), type: 'card.stopped', card: 1071, dedupe: 'card.stopped:session-end:launch:1071', payload: '{}' },
      ],
    })
    expect(flowLines(read.cards, PLAIN_LORE).slice(0, 2)).toEqual(['planned (0): —', 'in work (1): #1071'])
    expect(read.failure).toBe(`card #1071 lost its session at ${ago(HOUR)}`)
  })

  it('the last card.stopped with reason fault is the last failure', () => {
    const read = facts({ events: [
      { ts: ago(3 * HOUR), type: 'card.stopped', card: 1111, dedupe: 'card.stopped:session-end:launch:1111', payload: JSON.stringify({ reason: 'fault', detail: 'session ended' }) },
      { ts: ago(2 * HOUR), type: 'card.stopped', card: 1181, dedupe: 'card.stopped:no-pull-request:launch:1181', payload: JSON.stringify({ reason: 'fault', detail: 'no pull request' }) },
      { ts: ago(HOUR), type: 'card.stopped', card: 1182, payload: JSON.stringify({ reason: 'fault', detail: 'the answer session left it' }) },
      { ts: ago(HOUR / 2), type: 'card.stopped', card: 1183, payload: JSON.stringify({ reason: 'question-owner', detail: 'a question' }) },
    ] })
    expect(read.failure).toBe(`card #1182 stopped on a fault at ${ago(HOUR)}`)
  })

  it('names the step of each leased task: a review by its verdict, any other queue by its short head', () => {
    const services = facts({
      verdicts: [[9, 'changes'], [10, null]],
      tasks: [
        { queue: 'review', card: 3, pr: 9, head: null, state: 'leased' },
        { queue: 'review', card: 4, pr: 10, head: null, state: 'leased' },
        { queue: 'answer', card: 5, pr: null, head: 'abcdef1234567890', state: 'leased' },
        { queue: 'merge', card: 6, pr: null, head: null, state: 'leased' },
        { queue: 'review', card: 7, pr: null, head: null, state: 'queued' },
      ],
    }).services
    expect(services).toEqual([
      { role: 'review', task: '#3', tree: null, step: 'review changes' },
      { role: 'review', task: '#4', tree: null, step: 'review pending' },
      { role: 'answer', task: '#5', tree: null, step: 'answer abcdef1' },
      { role: 'merge', task: '#6', tree: null, step: 'merge' },
    ])
  })

  it('counts queued and leased review tasks as the review queue, and nothing else', () => {
    expect(facts({
      tasks: [
        { queue: 'review', card: 1, pr: null, head: null, state: 'queued' },
        { queue: 'review', card: 2, pr: null, head: null, state: 'leased' },
        { queue: 'review', card: 3, pr: null, head: null, state: 'done' },
        { queue: 'answer', card: 4, pr: null, head: null, state: 'queued' },
      ],
    }).reviewQueue).toBe(2)
  })

  it('names the last card that fell, and none when no card fell', () => {
    expect(facts({}).failure).toBeNull()
    expect(facts({ events: [
      { ts: ago(2 * HOUR), type: 'card.fell', card: 7, payload: '{}' },
      { ts: ago(HOUR), type: 'card.fell', card: 8, payload: '{}' },
    ] }).failure).toBe(`card #8 fell at ${ago(HOUR)}`)
    expect(facts({ events: [{ ts: null, type: 'card.fell', card: null, payload: '{}' }] }).failure).toBe('card #? fell')
  })

  it('a window subagent is at work from its start until its end, and an end without a start changes nothing', () => {
    const services = facts({ events: [
      subagent(ago(HOUR), { session: 's1', role: 'implementer', task: '#1071', tree: '/t', phase: 'started', step: 'implement 1/3 @ high' }),
      subagent(ago(HOUR), { session: 's2', role: 'review', task: '#1072', phase: 'started' }),
      subagent(ago(HOUR), { session: 's9', role: 'brief', task: '#1', phase: 'ended' }),
      subagent(ago(HOUR / 2), { session: 's2', role: 'review', task: '#1072', phase: 'ended' }),
    ] }).services
    expect(services).toEqual([{ role: 'implementer', task: '#1071', tree: '/t', step: 'implement 1/3 @ high' }])
  })

  it('a window subagent with no session, role or task falls back to role:task, agent and —, and a corrupt payload reads as an empty one', () => {
    const services = facts({ events: [
      subagent(ago(HOUR), { role: 'scan', task: '#5', phase: 'started' }),
      subagent(ago(HOUR), { role: 'scan', task: '#5', phase: 'started', step: 'again' }),
      subagent(ago(HOUR), 'not json'),
      subagent(ago(HOUR), '[1, 2]'),
    ] }).services
    expect(services).toEqual([
      { role: 'scan', task: '#5', tree: null, step: 'again' },
      { role: 'agent', task: '—', tree: null, step: 'started' },
    ])
  })

  it(`a window subagent whose start is older than ${SUBAGENT_SHOWN_HOURS} hours, or carries no time, has dropped out`, () => {
    const services = facts({ events: [
      subagent(ago(SUBAGENT_SHOWN_HOURS * HOUR + 1), { session: 'old', role: 'implementer', task: '#1', phase: 'started' }),
      subagent(null, { session: 'timeless', role: 'implementer', task: '#2', phase: 'started' }),
      subagent(ago(SUBAGENT_SHOWN_HOURS * HOUR), { session: 'edge', role: 'implementer', task: '#3', phase: 'started' }),
    ] }).services
    expect(services.map(service => service.task)).toEqual(['#3'])
  })

  it('the board shows the check matrix of a PR', () => {
    const head = 'b'.repeat(40)
    expect(facts({}).matrices).toEqual([])
    expect(facts({ events: [
      checkMatrix(922, 'a'.repeat(40), { full: null, killed: 9, survived: 9, notRun: 9 }),
      checkMatrix(922, head, { full: null, killed: 3, survived: 1, notRun: 2, skipped: 4 }),
      checkMatrix(921, null, { full: 'the change touches the harness', killed: 0, survived: 0, notRun: 0 }),
      checkMatrix(null, null, { killed: 1 }),
      checkMatrix(930, null, 'not json'),
    ] }).matrices).toEqual([
      { pr: 921, head: null, full: 'the change touches the harness', killed: 0, survived: 0, notRun: 0 },
      { pr: 922, head, full: null, killed: 3, survived: 1, notRun: 2 },
      { pr: 930, head: null, full: null, killed: 0, survived: 0, notRun: 0 },
    ])
  })

  it('the board shows the pulse and the free slots the bus records', () => {
    expect(facts({})).toMatchObject({ pulse: null, slots: [] })
    const seen = facts({
      tasks: [
        { queue: 'review', card: 1, pr: null, head: null, state: 'leased' },
        { queue: 'review', card: 2, pr: null, head: null, state: 'leased' },
        { queue: 'merge', card: 3, pr: null, head: null, state: 'leased' },
        { queue: 'review', card: 4, pr: null, head: null, state: 'queued' },
      ],
      events: [
        { ts: ago(5 * 60_000), type: 'netwatch.tick', card: null, payload: '{}' },
        { ts: ago(2 * 60_000), type: 'netwatch.tick', card: null, payload: '{}' },
      ],
    })
    expect(seen.pulse).toBe(ago(2 * 60_000))
    expect(seen.slots).toEqual([{ queue: 'merge', used: 1, total: null }, { queue: 'review', used: 2, total: null }])
  })

  it('a queue whose node has no heartbeat has no denominator', () => {
    const beat = (ts: string, payload: Record<string, unknown>): SeedEvent => ({ ts, type: PROCESS_HEARTBEAT, card: null, payload: JSON.stringify(payload) })
    const seen = facts({
      tasks: [
        { queue: 'review', card: 1, pr: null, head: null, state: 'leased' },
        { queue: 'merge', card: 2, pr: null, head: null, state: 'leased' },
      ],
      events: [
        beat(ago(3 * 60_000), { process: 'bus:answer', queue: 'answer', slots: 3 }),
        beat(ago(2 * 60_000), { process: 'bus:answer', queue: 'answer', slots: 5 }),
        beat(ago(2 * 60_000), { process: 'bus:merge', queue: 'merge', slots: 1 }),
        beat(ago(2 * 60_000), { process: 'netwatch' }),
        beat(ago(2 * 60_000), { process: 'bus:review', queue: 'review', slots: 'two' }),
      ],
    })
    expect(seen.slots).toEqual([
      { queue: 'answer', used: 0, total: 5 },
      { queue: 'merge', used: 1, total: 1 },
      { queue: 'review', used: 1, total: null },
    ])
  })

  it('reports a missing file as absent and a file it cannot query as unreadable, with the reason', () => {
    const dir = scratch()
    const missing = path.join(dir, 'missing.db')
    expect(busReaderAt(missing)()).toEqual({ status: 'absent', file: missing })
    const garbage = path.join(dir, 'garbage.db')
    writeFileSync(garbage, 'this is not a database')
    const reading = busReaderAt(garbage)()
    expect(reading).toMatchObject({ status: 'unreadable', file: garbage })
    expect(reading.status === 'unreadable' && reading.reason).toMatch(/\S/)
    const empty = writeBus(path.join(dir, 'empty.db'), {})
    writeFileSync(empty, '')
    expect(busReaderAt(empty)()).toMatchObject({ status: 'unreadable', file: empty })
  })
})
