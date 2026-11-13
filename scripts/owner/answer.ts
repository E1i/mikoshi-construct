import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { INTAKE_COMMAND, ownerMoveCommand, pnpmCommand } from '../core/owner-commands.js'
import { payloadOf } from '../core/stored.js'
import { CONTINUE_FIXES, continueFixesDecisionOf, observedHeadsOf } from '../policy/round-limit-decision.js'
import { ANSWER_SOURCE, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, changesRoundsOf, cleanUpdatesOf, decisionsInForceAt, defaultBusPath, LEASED, OPEN_WAIT, openBus, openPrOfCard, OWNER_SOURCE, OWNER_WAITS, QUEUED, REQUEST_DONE, REVIEW_ROUNDS, storedByKey, WINDOW_REQUEST } from '../window/requests/reach.js'
import { requestFromWindow } from '../window/window-requests.js'
import { ownerChannelOfBus, sayToOwnerChannel } from './channel.js'

export const ANSWER_SESSION = 'owner-answer'
export const ANSWER_WAIT_MS = 150_000
const POLL_MS = 1_000
const A_WAIT = /^Q\d+$/
const A_CARD = /^#?(\d+)$/
const WAITS_THE_ROUNDS_ANSWER: ReadonlySet<string> = new Set(['decision', 'command'])
const ENDED: ReadonlySet<string | null | undefined> = new Set(['merged', 'closed', 'dropped'])

export interface Answer {
  done: boolean
  why: string
}

interface Wait {
  id: string
  need: string
  card_id: number | null
  pr: number | null
}

interface Target {
  wait: Wait | null
  card: number | null
}

export type AnswerLore = typeof PLAIN_LORE

export interface AnswerRoom {
  db: DatabaseSync
  clock: () => Date
  channel: string
  lore: AnswerLore
  out: (line: string) => void
  answerOf: (request: number) => Answer | null
}

const WAIT_BY_ID = `SELECT id, need, card_id, pr FROM ${OWNER_WAITS} WHERE id = ? AND state = '${OPEN_WAIT}'`
const OPEN_WAITS_OF_CARD = `SELECT id, need, card_id, pr FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${OPEN_WAIT}' ORDER BY event_id`
const CARD_STATE = 'SELECT state FROM cards WHERE card_id = ?'
const LIVE_TASK = `SELECT task_key, queue, state FROM tasks WHERE card_id = ? AND state IN ('${QUEUED}', '${LEASED}') ORDER BY id DESC LIMIT 1`
const LATEST_TURN = `SELECT type FROM events WHERE card_id = ? AND legacy = 0 AND type IN ('${CARD_STOPPED}', '${CARD_ANSWERED}', '${CARD_STARTED}') ORDER BY id DESC LIMIT 1`

export function storedAnswerOf(db: DatabaseSync, request: number): Answer | null {
  const stored: ReturnType<typeof storedByKey> | undefined = storedByKey(db, `${WINDOW_REQUEST}:${request}:answered`)
  if (stored === undefined)
    return null
  return { done: stored.type === REQUEST_DONE, why: String(payloadOf(stored).detail) }
}

function requested(room: AnswerRoom, payload: Record<string, unknown>, word: string): Answer {
  sayToOwnerChannel(room.channel, word, room.clock())
  const request = requestFromWindow(room.db, room.clock().toISOString(), ANSWER_SESSION, payload)
  return room.answerOf(request) ?? { done: false, why: room.lore.answerUnanswered(request, ANSWER_WAIT_MS / 1000) }
}

function targetOf(db: DatabaseSync, named: string): Target | readonly string[] | null {
  if (A_WAIT.test(named)) {
    const wait = db.prepare(WAIT_BY_ID).get(named) as Wait | undefined
    return wait === undefined ? null : { wait, card: wait.card_id }
  }
  const card = A_CARD.exec(named)
  if (card === null)
    return null
  const waits = db.prepare(OPEN_WAITS_OF_CARD).all(Number(card[1])) as unknown as Wait[]
  return waits.length > 1 ? waits.map(wait => wait.id) : { wait: waits[0] ?? null, card: Number(card[1]) }
}

function pastTheLimit(db: DatabaseSync, target: Target): number | null {
  if (target.wait !== null && !WAITS_THE_ROUNDS_ANSWER.has(target.wait.need))
    return null
  const pr = target.wait?.pr ?? (target.card === null ? null : openPrOfCard(db, target.card))
  return pr !== null && changesRoundsOf(db, pr) >= REVIEW_ROUNDS ? pr : null
}

function closeWait(room: AnswerRoom, wait: Wait, words: string): number {
  const closed = requested(room, { kind: 'owner.wait.close', id: wait.id, from: ANSWER_SOURCE }, `${wait.id}: ${words}`)
  room.out(closed.done ? room.lore.answerClosed(wait.id, closed.why) : room.lore.answerNotClosed(wait.id, closed.why))
  return closed.done ? 0 : 1
}

function continueFixes(room: AnswerRoom, target: Target, pr: number, words: string): number {
  const head = observedHeadsOf(room.db, pr).at(-1)
  if (head === undefined) {
    room.out(room.lore.answerNoHead(pr))
    return 1
  }
  const decided = `${CONTINUE_FIXES} PR #${pr} at ${head}: ${words}`
  const held = continueFixesDecisionOf(decisionsInForceAt(room.db, room.clock()), pr, head, cleanUpdatesOf(room.db, pr))
  if (held !== null) {
    room.out(room.lore.answerContinueFixesHeld(pr, head, held))
  }
  else {
    const cards = target.card === null ? [] : [`#${target.card}`]
    const written = requested(room, { kind: 'decisions:add', text: `${OWNER_SOURCE} ${decided}`, from: ANSWER_SOURCE, cards, supersedes: [] }, decided)
    room.out(written.done ? room.lore.answerContinueFixes(pr, head, written.why) : room.lore.answerContinueFixesNot(pr, written.why))
    if (!written.done)
      return 1
  }
  return target.wait === null ? 0 : closeWait(room, target.wait, decided)
}

function nothingToMove(room: AnswerRoom, card: number, words: string): number {
  const state = (room.db.prepare(CARD_STATE).get(card) as { state: string | null } | undefined)?.state
  const task = room.db.prepare(LIVE_TASK).get(card) as { task_key: string, queue: string, state: string } | undefined
  const turn = (room.db.prepare(LATEST_TURN).get(card) as { type: string } | undefined)?.type
  const bind = pnpmCommand('bus:request', 'decisions:add', '--from', ANSWER_SOURCE, '--card', `#${card}`, JSON.stringify(`${OWNER_SOURCE} ${words}`))
  const [reason, move] = state === undefined || ENDED.has(state)
    ? [room.lore.answerCardEnded(card, state ?? null), INTAKE_COMMAND]
    : task !== undefined
      ? [room.lore.answerCardTask(task.queue, task.task_key, task.state), bind]
      : turn === CARD_STOPPED
        ? [room.lore.answerCardStopped(card), ownerMoveCommand('launch', card)]
        : [room.lore.answerCardIdle(card), bind]
  room.out(room.lore.answerNothingToMove(card, reason, move))
  return 1
}

export function runOwnerAnswer(args: readonly string[], room: AnswerRoom): number {
  const [named, words] = args
  if (args.length !== 2 || named === undefined || words === undefined || words.trim() === '' || words.startsWith('--')) {
    room.out(room.lore.answerUsage)
    return 2
  }
  const target = targetOf(room.db, named)
  if (target === null) {
    room.out(room.lore.answerNoWait(named))
    return 1
  }
  if (Array.isArray(target)) {
    room.out(room.lore.answerManyWaits(Number(A_CARD.exec(named)![1]), target as readonly string[]))
    return 1
  }
  const one = target as Target
  const pr = pastTheLimit(room.db, one)
  if (pr !== null)
    return continueFixes(room, one, pr, words.trim())
  if (one.wait !== null)
    return closeWait(room, one.wait, words.trim())
  return nothingToMove(room, one.card!, words.trim())
}

export function pollingAnswerOf(db: DatabaseSync, waitMs: number, pollMs: number = POLL_MS): (request: number) => Answer | null {
  return (request) => {
    const until = Date.now() + waitMs
    for (;;) {
      const answer = storedAnswerOf(db, request)
      if (answer !== null || Date.now() >= until)
        return answer
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs)
    }
  }
}

function main(argv: readonly string[]): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    const lore = argv.includes('--plain') ? PLAIN_LORE : LORE
    return runOwnerAnswer(argv.filter(argument => argument !== '--plain'), { db, clock: () => new Date(), channel: ownerChannelOfBus(os.homedir(), busPath), lore, out: line => console.log(line), answerOf: pollingAnswerOf(db, ANSWER_WAIT_MS) })
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
