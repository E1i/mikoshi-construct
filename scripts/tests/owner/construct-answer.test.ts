import type { Answer } from '../../owner/answer.js'
import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { PLAIN_LORE } from '../../../src/ui/lore.js'
import { openOwnerWait } from '../../core/db.js'
import { closedByRounds } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { ANSWER_SESSION, pollingAnswerOf, runOwnerAnswer, storedAnswerOf } from '../../owner/answer.js'
import { decisionsFileOf } from '../../policy/decisions/decisions.js'
import { decisionsAdderOfBus, decisionsSettlerOfBus } from '../../policy/decisions/projection.js'
import { CONTINUE_FIXES } from '../../policy/round-limit-decision.js'
import { decisionsInForceAt } from '../../policy/shards.js'
import { busProjections } from '../../supervisor/composition.js'
import { WindowRequests } from '../../window/window-requests.js'
import { sha } from '../bus/github-fake.js'
import { eventCount, liveBench, spendReviewRounds } from '../bus/merge-bench.js'

interface Room {
  bench: MergeBench
  channel: string
  lines: string[]
}

interface Fixture {
  card: number
  pr: number
  need: 'decision' | 'command'
  waits: number
}

const FIXTURES: Readonly<Record<string, Fixture>> = {
  'Q321/Q322': { card: 1847, pr: 1578, need: 'decision', waits: 2 },
  'Q332': { card: 1843, pr: 1590, need: 'decision', waits: 1 },
  'Q335': { card: 1870, pr: 1594, need: 'command', waits: 1 },
  'Q336': { card: 1864, pr: 1586, need: 'decision', waits: 1 },
}

const HEAD = sha('a')
const OWNER_MARK = /^\[owner\] /
const rooms: { bench: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { bench, root } of rooms.splice(0)) {
    bench.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function cardLine(card: number): string {
  return `#${card} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`
}

function roomWithPr(card: number, pr: number): Room {
  const bench = liveBench()
  const root = mkdtempSync(path.join(tmpdir(), 'construct-answer-'))
  rooms.push({ bench, root })
  writeFileSync(decisionsFileOf(bench.busPath), '')
  bench.gitHub.open({ number: pr, head: HEAD, body: cardLine(card) })
  bench.tick()
  return { bench, channel: path.join(root, 'owner-answers'), lines: [] }
}

function waitOn(room: Room, card: number, pr: number, need: Fixture['need']): string {
  const wait = openOwnerWait(room.bench.db, room.bench.clock.now().toISOString(), 'policy', { need, text: `card #${card} waits for the owner`, card, pr, ...(need === 'command' ? { command: `pnpm bus:request amend --card ${card}` } : {}) })
  reduce(room.bench.db, 'pending', busProjections())
  return wait
}

function refuse(): never {
  throw new Error('an answer uses no other tool')
}

function tools(room: Room): RequestTools {
  return { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: decisionsAdderOfBus(room.bench.db, room.bench.busPath, room.bench.clock.now), settleDecisions: decisionsSettlerOfBus(room.bench.db, room.bench.busPath, room.bench.clock.now, busProjections()), causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
}

function busRunAnswers(room: Room): (request: number) => Answer | null {
  return (request) => {
    reduce(room.bench.db, 'pending', busProjections())
    new WindowRequests(room.bench.db, room.bench.clock.now, tools(room), room.channel, () => null, process.cwd(), room.bench.gitHub.client).run()
    return storedAnswerOf(room.bench.db, request)
  }
}

function answer(room: Room, named: string, words: string, answerOf = busRunAnswers(room)): number {
  const code = runOwnerAnswer([named, words], { db: room.bench.db, clock: room.bench.clock.now, channel: room.channel, lore: PLAIN_LORE, out: line => room.lines.push(line), answerOf })
  reduce(room.bench.db, 'pending', busProjections())
  return code
}

function stateOf(room: Room, wait: string): string {
  return (room.bench.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(wait) as { state: string }).state
}

function decisionsOn(room: Room, card: number): string[] {
  return decisionsInForceAt(room.bench.db, room.bench.clock.now()).filter(decision => decision.cards.includes(card)).map(decision => decision.text.replace(OWNER_MARK, ''))
}

function answered(room: Room, named: string, words: string): number {
  const code = answer(room, named, words)
  expect(code, room.lines.join('\n')).toBe(0)
  return code
}

describe('construct answer <Q|#card> "words"', () => {
  it.each(Object.entries(FIXTURES))('the waits of 2026-11-12 close through one command: %s', (_name, fixture) => {
    const room = roomWithPr(fixture.card, fixture.pr)
    const waits = Array.from({ length: fixture.waits }, () => waitOn(room, fixture.card, fixture.pr, fixture.need))

    if (waits.length > 1) {
      const before = eventCount(room.bench.db)
      expect(answer(room, `#${fixture.card}`, 'the second path')).toBe(1)
      expect(room.lines.at(-1)).toBe(PLAIN_LORE.answerManyWaits(fixture.card, waits))
      expect(eventCount(room.bench.db)).toBe(before)
      expect(existsSync(room.channel)).toBe(false)
      answered(room, waits[0]!, 'the first path')
      expect(stateOf(room, waits[0]!)).toBe('closed')
    }

    answered(room, `#${fixture.card}`, 'the second path')
    expect(room.lines.at(-1)).toContain(`${waits.at(-1)!} closed:`)
    for (const wait of waits)
      expect(stateOf(room, wait)).toBe('closed')
    expect(decisionsOn(room, fixture.card)).toEqual(waits.map((wait, at) => `${wait}: the ${at === waits.length - 1 ? 'second' : 'first'} path`))
    expect(readdirSync(room.channel).every(file => file.endsWith('.used'))).toBe(true)

    expect(answer(room, waits.at(-1)!, 'once more')).toBe(1)
    expect(room.lines.at(-1)).toBe(PLAIN_LORE.answerNoWait(waits.at(-1)!))
  })

  it('an answer past the round limit queues a review on the current head', () => {
    const [card, pr] = [1743, 1588]
    const room = roomWithPr(card, pr)
    spendReviewRounds(room.bench, pr, HEAD)
    const wait = waitOn(room, card, pr, 'decision')
    const now = (): string => room.bench.clock.now().toISOString()
    expect(closedByRounds(room.bench.db, now(), 'answer', pr, HEAD)).toBe(true)

    answered(room, wait, 'go on with the fixes')

    const decided = `${CONTINUE_FIXES} PR #${pr} at ${HEAD}: go on with the fixes`
    expect(room.lines).toEqual([expect.stringContaining(`continue-fixes written for PR #${pr} at ${HEAD}`), expect.stringContaining(`${wait} closed:`)])
    expect(stateOf(room, wait)).toBe('closed')
    expect(decisionsOn(room, card)).toEqual([decided])
    expect(closedByRounds(room.bench.db, now(), 'answer', pr, HEAD)).toBe(false)

    expect(answer(room, `#${card}`, 'go on with the fixes')).toBe(0)
    expect(room.lines.at(-1)).toMatch(new RegExp(`^D-\\d+ already holds continue-fixes for PR #${pr} at ${HEAD}`))
    expect(decisionsOn(room, card)).toEqual([decided])

    const fixed = sha('e')
    room.bench.gitHub.open({ number: pr, head: fixed, body: cardLine(card) })
    room.bench.tick()
    expect(closedByRounds(room.bench.db, now(), 'review', pr, fixed)).toBe(false)
  })

  it('a decision on a card with no open wait names that nothing moves and proposes the move', () => {
    const [card, pr] = [1864, 1586]
    const room = roomWithPr(card, pr)
    const before = eventCount(room.bench.db)

    expect(answer(room, `#${card}`, 'D-524: back for fixes at the head')).toBe(1)

    expect(room.lines).toHaveLength(1)
    expect(room.lines[0]).toContain(`Card #${card} has no open wait`)
    expect(room.lines[0]).toContain('The move that would act on it: pnpm bus:request')
    expect(eventCount(room.bench.db)).toBe(before)
    expect(existsSync(room.channel)).toBe(false)
    expect(room.bench.db.prepare('SELECT count(*) AS n FROM events WHERE actor LIKE ?').get(`%${ANSWER_SESSION}`)).toEqual({ n: 0 })
  })

  it('an answer with no words or no target writes nothing and says how to answer', () => {
    const room = roomWithPr(1864, 1586)
    expect(runOwnerAnswer(['Q1'], { db: room.bench.db, clock: room.bench.clock.now, channel: room.channel, lore: PLAIN_LORE, out: line => room.lines.push(line), answerOf: busRunAnswers(room) })).toBe(2)
    expect(answer(room, 'nonsense', 'words')).toBe(1)
    expect(room.lines).toEqual([PLAIN_LORE.answerUsage, PLAIN_LORE.answerNoWait('nonsense')])
  })

  it('names the request bus:run left unanswered instead of reporting a close', () => {
    const room = roomWithPr(1864, 1586)
    const wait = waitOn(room, 1864, 1586, 'decision')

    expect(answer(room, wait, 'the second path', pollingAnswerOf(room.bench.db, 0))).toBe(1)

    expect(room.lines).toEqual([expect.stringMatching(new RegExp(`^${wait} did not close: bus:run did not answer window.request \\d+ within 150 s`))])
    expect(stateOf(room, wait)).toBe('open')
    expect(busRunAnswers(room)(0)).toBeNull()
    expect(stateOf(room, wait)).toBe('closed')
  })
})
