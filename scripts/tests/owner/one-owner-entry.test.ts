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
import { OWNER_ANSWER_COMMAND, OWNER_MOVE_REQUESTS, OWNER_MOVES, ownerMoveCommand, ownerWaitCommand } from '../../core/owner-commands.js'
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

function printedFor(at: Room, wait: string): string {
  const row = openOwnerWaits(at.bench.db).find(open => open.id === wait)!
  const printed = ownerWaitCommand({ id: row.id, need: row.need, card: row.card, pr: row.pr }, row.command)
  expect(row.command).toBe(printed)
  return printed
}

function ownerRuns(at: Room, printed: string): number {
  expect(printed.startsWith(`${OWNER_ANSWER_COMMAND} `)).toBe(true)
  expect(printed.endsWith(` ${PRINTED_WORDS}`)).toBe(true)
  const named = printed.slice(OWNER_ANSWER_COMMAND.length + 1, -PRINTED_WORDS.length - 1)
  return runOwnerAnswer([named, OWNER_WORDS], at.bench.db, at.channel, at.bench.clock.now(), () => {}, requestFromWindow)
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

    const printed = printedFor(at, wait)

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

    const printed = printedFor(at, wait)

    expect(printed).toBe(`${OWNER_ANSWER_COMMAND} ${wait} ${PRINTED_WORDS}`)
    expect(ownerRuns(at, printed)).toBe(0)
    const kind = OWNER_MOVE_REQUESTS[OWNER_MOVES.indexOf(move)]
    const requests = eventsOf(at.bench.db, WINDOW_REQUEST)
    expect(requests).toEqual([
      expect.objectContaining({ kind, ...(move === 'requeue' ? { task_key: TASK_KEY } : { card: CARD }), from: ANSWER_SOURCE }),
      expect.objectContaining({ kind: 'owner.answer', id: wait, text: OWNER_WORDS, from: ANSWER_SOURCE }),
    ])
    expect(channelWords(at)).toContain(asked)
  })

  it('a window command and a shell command stay as they were', () => {
    const at = room()
    const amend = `pnpm bus:request amend --card ${CARD}`
    expect(printedFor(at, waitAsking(at, 'command', amend))).toBe(amend)
    expect(ownerWaitCommand({ id: 'Q9', need: 'command', card: null, pr: null }, SHELL_COMMAND)).toBe(`${OWNER_ANSWER_COMMAND} Q9 ${PRINTED_WORDS}`)
  })
})
