import type { BusFacts, BusReading } from '../../src/commands/board/bus.js'
import type { BusSeed } from './bus-fixture.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { busReaderAt, SUBAGENT_SHOWN_HOURS } from '../../src/commands/board/bus.js'
import { subagent, writeBus } from './bus-fixture.js'

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
      { id: 1, state: 'queued', lane: 'a', line: 'card: #1 alpha' },
      { id: 2, state: 'changes', lane: null, line: null },
    ])
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
