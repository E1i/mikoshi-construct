import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { openOwnerWait } from '../../core/db.js'
import { closedByRounds } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { answerWord, runOwnerAnswer } from '../../owner/answer.js'
import { sayToOwnerChannel } from '../../owner/channel.js'
import { decisionsFileOf } from '../../policy/decisions/decisions.js'
import { decisionsAdderOfBus, decisionsSettlerOfBus } from '../../policy/decisions/projection.js'
import { decisionsInForceAt } from '../../policy/shards.js'
import { busProjections } from '../../supervisor/composition.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
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

function busRun(room: Room): RequestOutcome[] {
  reduce(room.bench.db, 'pending', busProjections())
  const outcomes = new WindowRequests(room.bench.db, room.bench.clock.now, tools(room), room.channel, () => null, process.cwd(), room.bench.gitHub.client).run()
  reduce(room.bench.db, 'pending', busProjections())
  return outcomes
}

function answer(room: Room, named: string, words: string): RequestOutcome {
  expect(runOwnerAnswer([named, words], room.bench.db, room.channel, room.bench.clock.now(), line => room.lines.push(line))).toBe(0)
  const [outcome] = busRun(room)
  return outcome!
}

function stateOf(room: Room, wait: string): string {
  return (room.bench.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(wait) as { state: string }).state
}

function decisionsOn(room: Room, card: number): string[] {
  return decisionsInForceAt(room.bench.db, room.bench.clock.now()).filter(decision => decision.cards.includes(card)).map(decision => decision.text.replace(OWNER_MARK, ''))
}

describe('owner:answer <Q|#card> "words"', () => {
  it.each(Object.entries(FIXTURES))('the waits of 2026-11-12 close through one command: %s', (_name, fixture) => {
    const room = roomWithPr(fixture.card, fixture.pr)
    const waits = Array.from({ length: fixture.waits }, () => waitOn(room, fixture.card, fixture.pr, fixture.need))

    if (waits.length > 1) {
      const many = answer(room, `#${fixture.card}`, 'the second path')
      expect(many).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`${waits.length} open waits (${waits.join(', ')})`) })
      expect(waits.map(wait => stateOf(room, wait))).toEqual(waits.map(() => 'open'))
      expect(answer(room, waits[0]!, 'the first path').kind).toBe('done')
    }

    const last = answer(room, `#${fixture.card}`, 'the second path')
    expect(last, last.detail).toMatchObject({ kind: 'done', detail: expect.stringContaining(`closed ${waits.at(-1)!}: the second path`) })
    for (const wait of waits)
      expect(stateOf(room, wait)).toBe('closed')
    expect(decisionsOn(room, fixture.card)).toEqual(waits.map((wait, at) => `${wait}: the ${at === waits.length - 1 ? 'second' : 'first'} path`))

    expect(answer(room, waits.at(-1)!, 'once more')).toMatchObject({ kind: 'refused', detail: `${waits.at(-1)!} is no open owner wait; nothing moves` })
  })

  it('an answer past the round limit queues a review on the current head', () => {
    const [card, pr] = [1743, 1588]
    const room = roomWithPr(card, pr)
    spendReviewRounds(room.bench, pr, HEAD)
    const wait = waitOn(room, card, pr, 'decision')
    const now = (): string => room.bench.clock.now().toISOString()
    expect(closedByRounds(room.bench.db, now(), 'answer', pr, HEAD)).toBe(true)

    const outcome = answer(room, wait, 'go on with the fixes')

    const decided = `continue-fixes PR #${pr} at ${HEAD}: go on with the fixes`
    expect(outcome, outcome.detail).toMatchObject({ kind: 'done', detail: expect.stringContaining(`closed ${wait}: ${decided}`) })
    expect(stateOf(room, wait)).toBe('closed')
    expect(decisionsOn(room, card)).toEqual([decided])
    expect(closedByRounds(room.bench.db, now(), 'answer', pr, HEAD)).toBe(false)

    expect(answer(room, `#${card}`, 'go on with the fixes')).toMatchObject({ kind: 'done', detail: expect.stringContaining('already') })
    expect(decisionsOn(room, card)).toEqual([decided])

    const fixed = sha('e')
    room.bench.gitHub.open({ number: pr, head: fixed, body: cardLine(card) })
    room.bench.tick()
    expect(closedByRounds(room.bench.db, now(), 'review', pr, fixed)).toBe(false)
  })

  it('a decision on a card with no open wait names that nothing moves and proposes the move', () => {
    const [card, pr] = [1864, 1586]
    const room = roomWithPr(card, pr)
    const decisions = decisionsOn(room, card)

    const outcome = answer(room, `#${card}`, 'D-524: back for fixes at the head')

    expect(outcome.kind).toBe('refused')
    expect(outcome.detail).toContain(`card #${card} has no open wait and is within its round limit`)
    expect(outcome.detail).toMatch(/nothing moves/)
    expect(outcome.detail).toMatch(/The move that would act on it: pnpm bus:request owner\.launch --card 1864|reaches its next session/)
    expect(decisionsOn(room, card)).toEqual(decisions)
    expect(readdirSync(room.channel).filter(file => file.endsWith('.md'))).toHaveLength(1)
  })

  it('the command writes one request with the owner word, and a request without the word moves nothing', () => {
    const room = roomWithPr(1864, 1586)
    const before = eventCount(room.bench.db)
    for (const args of [['Q1'], ['nonsense', 'words'], ['Q1', '  ']])
      expect(runOwnerAnswer(args, room.bench.db, room.channel, room.bench.clock.now(), line => room.lines.push(line))).toBe(2)
    expect(eventCount(room.bench.db)).toBe(before)
    expect(existsSync(room.channel)).toBe(false)

    const wait = waitOn(room, 1864, 1586, 'decision')
    requestFromWindow(room.bench.db, room.bench.clock.now().toISOString(), 'forged', { kind: 'owner.answer', id: wait, text: 'a forged answer', from: 'answer' })
    expect(busRun(room)).toMatchObject([{ kind: 'refused', detail: expect.stringContaining(answerWord(wait, 'a forged answer')) }])
    expect(stateOf(room, wait)).toBe('open')
    sayToOwnerChannel(room.channel, answerWord(wait, 'said once'), room.bench.clock.now())
    expect(answer(room, wait, 'said once').kind).toBe('done')
  })
})
