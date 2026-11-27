import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { OWNER_WAIT_NEEDS } from '../../core/bus-readings.js'
import { openOwnerWaits } from '../../core/card-readings.js'
import { openOwnerWait } from '../../core/db.js'
import { WINDOW_REQUEST } from '../../core/events.js'
import { ANSWER_SOURCE } from '../../core/inbox.js'
import { OWNER_ANSWER_COMMAND, OWNER_MOVE_REQUESTS, OWNER_MOVES, ownerMergeLine, ownerMoveCommand, ownerWaitCommand } from '../../core/owner-commands.js'
import { reduce } from '../../core/reducer.js'
import { runOwnerAnswer } from '../../owner/answer.js'
import { decisionsFileOf } from '../../policy/decisions/decisions.js'
import { decisionsAdderOfBus, decisionsSettlerOfBus } from '../../policy/decisions/projection.js'
import { busProjections, DECISION_EVENT_READS } from '../../supervisor/composition.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, liveBench } from '../bus/merge-bench.js'

interface Room {
  bench: MergeBench
  channel: string
}

const CARD = 2143
const PR = 2200
const TASK_KEY = 'answer:2143:2200'
const SHELL_COMMAND = 'rm /tmp/bus.lock'
const OWNER_WORDS = 'go on'
const PRINTED_WORDS = '"…"'
const PLACEHOLDER = '…'
const MOVE_REASON = 'the owner moves it'
const rooms: { bench: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { bench, root } of rooms.splice(0)) {
    bench.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function room(): Room {
  const bench = liveBench()
  const root = mkdtempSync(path.join(tmpdir(), 'one-owner-entry-'))
  rooms.push({ bench, root })
  writeFileSync(decisionsFileOf(bench.busPath), '')
  bench.gitHub.open({ number: PR, head: sha('a'), body: `#${CARD} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —` })
  bench.tick()
  return { bench, channel: path.join(root, 'owner-answers') }
}

function refuse(): never {
  throw new Error('an answer uses no other tool')
}

function tools(at: Room): RequestTools {
  return { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: decisionsAdderOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now, DECISION_EVENT_READS), settleDecisions: decisionsSettlerOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now, busProjections(), DECISION_EVENT_READS), causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
}

function busRun(at: Room): RequestOutcome[] {
  reduce(at.bench.db, 'pending', busProjections())
  const outcomes = new WindowRequests(at.bench.db, at.bench.clock.now, tools(at), at.channel, () => null, process.cwd(), at.bench.gitHub.client).run()
  reduce(at.bench.db, 'pending', busProjections())
  return outcomes
}

function waitAsking(at: Room, need: string, command: string | null): string {
  const wait = openOwnerWait(at.bench.db, at.bench.clock.now().toISOString(), 'policy', { need: need as typeof OWNER_WAIT_NEEDS[number], text: `card #${CARD} waits on ${need} ${command ?? ''}`, card: CARD, pr: PR, ...(command === null ? {} : { command }) })
  reduce(at.bench.db, 'pending', busProjections())
  return wait
}

function printedFor(at: Room, wait: string, asked: string | null = null): string {
  const row = openOwnerWaits(at.bench.db).find(open => open.id === wait)!
  const printed = ownerWaitCommand({ id: row.id, need: row.need, card: row.card, pr: row.pr }, asked)
  expect(row.command).toBe(printed)
  return printed
}

function ownerRuns(at: Room, printed: string, words = OWNER_WORDS): number {
  expect(printed.startsWith(`${OWNER_ANSWER_COMMAND} `)).toBe(true)
  const [named, ...said] = printed.slice(OWNER_ANSWER_COMMAND.length + 1).split(' ')
  const quoted = said.join(' ')
  expect(quoted.startsWith('"') && quoted.endsWith(`${PLACEHOLDER}"`)).toBe(true)
  return answers(at, named!, `${quoted.slice(1, -PLACEHOLDER.length - 1)}${words}`)
}

function answers(at: Room, named: string, words: string): number {
  return runOwnerAnswer([named, words], at.bench.db, at.channel, at.bench.clock.now(), () => {}, requestFromWindow)
}

function requestsOf(at: Room): Record<string, unknown>[] {
  return eventsOf(at.bench.db, WINDOW_REQUEST) as Record<string, unknown>[]
}

function outcomeOf(outcomes: readonly RequestOutcome[], request: number): RequestOutcome | undefined {
  return outcomes.find(outcome => outcome.request === request)
}

function requestIds(at: Room): number[] {
  return (at.bench.db.prepare('SELECT id FROM events WHERE type = ? ORDER BY id').all(WINDOW_REQUEST) as { id: number }[]).map(row => row.id)
}

function stateOf(at: Room, wait: string): string {
  return (at.bench.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(wait) as { state: string }).state
}

function channelWords(at: Room): string {
  return readdirSync(at.channel).filter(file => file.endsWith('.md')).map(file => readFileSync(path.join(at.channel, file), 'utf8')).join('\n')
}

const ASKED_BY_NEED: Readonly<Record<typeof OWNER_WAIT_NEEDS[number], string | null>> = {
  decision: null,
  merge: null,
  command: SHELL_COMMAND,
}

describe('one owner entry: the board prints owner:answer and owner:answer does the rest', () => {
  it.each(OWNER_WAIT_NEEDS)('every owner wait need prints one owner answer command that closes it: %s', (need) => {
    const at = room()
    const wait = waitAsking(at, need, ASKED_BY_NEED[need])

    const printed = printedFor(at, wait, ASKED_BY_NEED[need])

    if (need === 'merge') {
      expect(printed).toBe(ownerMergeLine(PR))
      expect(stateOf(at, wait)).toBe('open')
      at.bench.gitHub.close(PR, true)
      at.bench.tick()
      reduce(at.bench.db, 'pending', busProjections())
      expect(stateOf(at, wait)).toBe('closed')
      return
    }
    expect(printed).toBe(`${OWNER_ANSWER_COMMAND} ${wait} ${PRINTED_WORDS}`)
    expect(ownerRuns(at, printed)).toBe(0)
    const outcomes = busRun(at)
    expect(outcomes, JSON.stringify(outcomes)).toMatchObject([{ kind: 'done' }])
    expect(stateOf(at, wait)).toBe('closed')
  })

  it.each(OWNER_MOVES)('an owner answer on a move wait writes the move itself for every owner move: %s', (move) => {
    const at = room()
    const target = move === 'requeue' ? TASK_KEY : CARD
    const asked = ownerMoveCommand(move, target)
    const wait = waitAsking(at, 'command', asked)

    const printed = printedFor(at, wait, asked)

    expect(printed).toBe(`${OWNER_ANSWER_COMMAND} ${wait} "${move}: ${PLACEHOLDER}"`)
    expect(ownerRuns(at, printed, MOVE_REASON)).toBe(0)
    const kind = OWNER_MOVE_REQUESTS[OWNER_MOVES.indexOf(move)]
    const [moved, closing] = requestIds(at)
    expect(requestsOf(at)).toEqual([
      expect.objectContaining({ kind, ...(move === 'requeue' ? { task_key: TASK_KEY } : { card: CARD }), reason: MOVE_REASON, from: ANSWER_SOURCE }),
      expect.objectContaining({ kind: 'owner.answer', id: wait, text: `${move}: ${MOVE_REASON}`, from: ANSWER_SOURCE }),
    ])
    expect(channelWords(at)).toContain(asked)
    const outcomes = busRun(at)
    expect(outcomeOf(outcomes, closing!)?.kind).toBe(outcomeOf(outcomes, moved!)?.kind === 'done' ? 'done' : 'refused')
    expect(stateOf(at, wait)).toBe(outcomeOf(outcomes, moved!)?.kind === 'done' ? 'closed' : 'open')
  })

  it.each(OWNER_MOVES)('an owner answer that does not confirm the move closes the wait and writes no move: %s', (move) => {
    const at = room()
    const wait = waitAsking(at, 'command', ownerMoveCommand(move, move === 'requeue' ? TASK_KEY : CARD))

    expect(answers(at, wait, 'no, let it run')).toBe(0)

    expect(requestsOf(at)).toEqual([expect.objectContaining({ kind: 'owner.answer', id: wait, text: 'no, let it run' })])
    expect(busRun(at)).toMatchObject([{ kind: 'done' }])
    expect(stateOf(at, wait)).toBe('closed')
  })

  it('a refused move leaves its wait open', () => {
    const at = room()
    const wait = waitAsking(at, 'command', ownerMoveCommand('stop', CARD))

    expect(answers(at, wait, `stop: ${MOVE_REASON}`)).toBe(0)

    const [moved, closing] = requestIds(at)
    const outcomes = busRun(at)
    expect(outcomeOf(outcomes, moved!), JSON.stringify(outcomes)).toMatchObject({ kind: 'refused' })
    expect(outcomeOf(outcomes, closing!)).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`window.request ${moved} (owner.stop ${CARD}), was refused`) })
    expect(stateOf(at, wait)).toBe('open')
  })

  it('an answer by card with several open move waits writes no move', () => {
    const at = room()
    waitAsking(at, 'command', ownerMoveCommand('launch', CARD))
    waitAsking(at, 'command', ownerMoveCommand('takeover', CARD))
    expect(openOwnerWaits(at.bench.db)).toHaveLength(2)

    expect(answers(at, `#${CARD}`, `launch: ${MOVE_REASON}`)).toBe(0)

    expect(requestsOf(at).map(request => request.kind)).toEqual(['owner.answer'])
  })

  it('an answer on a closed move wait writes no move', () => {
    const at = room()
    const wait = waitAsking(at, 'command', ownerMoveCommand('launch', CARD))
    answers(at, wait, 'no')
    busRun(at)
    expect(stateOf(at, wait)).toBe('closed')

    expect(answers(at, wait, `launch: ${MOVE_REASON}`)).toBe(0)

    expect(requestsOf(at).map(request => request.kind)).toEqual(['owner.answer', 'owner.answer'])
  })

  it('a window command and a shell command stay as they were', () => {
    const at = room()
    const amend = `pnpm bus:request amend --card ${CARD}`
    expect(printedFor(at, waitAsking(at, 'command', amend), amend)).toBe(amend)
    expect(ownerWaitCommand({ id: 'Q9', need: 'command', card: null, pr: null }, SHELL_COMMAND)).toBe(`${OWNER_ANSWER_COMMAND} Q9 ${PRINTED_WORDS}`)
  })
})
