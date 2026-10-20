import type { BusFacts, BusReading } from '../../src/commands/board/bus.js'
import type { BusSeed } from './bus-fixture.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { busReaderAt, SUBAGENT_SHOWN_HOURS } from '../../src/commands/board/bus.js'
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
  it('reads every card with its state, lane and card line, in card order', () => {
    expect(facts({ cards: [{ id: 2, state: 'changes', lane: null, line: null }, { id: 1, state: 'queued', lane: 'a', line: 'card: #1 alpha' }] }).cards).toEqual([
      { id: 1, state: 'queued', lane: 'a', line: 'card: #1 alpha', since: null, body: true, closed: false },
      { id: 2, state: 'changes', lane: null, line: null, since: null, body: true, closed: false },
    ])
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
    expect(seen.slots).toEqual([{ queue: 'merge', used: 1 }, { queue: 'review', used: 2 }])
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
