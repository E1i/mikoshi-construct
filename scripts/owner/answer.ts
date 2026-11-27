import type { DatabaseSync } from 'node:sqlite'
import type { AskedOwnerMove } from '../core/owner-commands.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { openWaitsOfCard, ownerWaitOf } from '../core/card-readings.js'
import { OPEN_WAIT } from '../core/db.js'
import { events } from '../core/events-query.js'
import { OWNER_WAIT_OPENED } from '../core/events.js'
import { ANSWER_SOURCE } from '../core/inbox.js'
import { askedOwnerMoveOf, ownerMoveCommand } from '../core/owner-commands.js'
import { withOwnerShellBus } from '../policy/decisions/add.js'
import { requestFromWindow } from '../policy/decisions/window-door.js'
import { sayToOwnerChannel } from './channel.js'

export const PREFIX = '[owner:answer] '
export const ANSWER_SESSION = 'owner-answer'
export const ANSWER_WORD = 'answer'
const A_WAIT = /^Q\d+$/
const A_CARD = /^#?(\d+)$/
const STOP_WORD = /^stop:\s*(\S[\s\S]*)$/i
const TYPOGRAPHIC_QUOTES_AT_ENDS = /^[«»“”‘’\s]+|[«»“”‘’\s]+$/g

export const USAGE = 'usage: construct-answer <Q<N>|#<card>> <the owner\'s words, quotes optional>'

export type WindowRequest = (db: DatabaseSync, ts: string, session: string, request: Record<string, unknown>) => number

export function answerWord(target: string, words: string): string {
  return `${ANSWER_WORD} ${target}: ${words}`
}

type Target = { id: string } | { card: number }

function targetOf(named: string): Target | null {
  if (A_WAIT.test(named))
    return { id: named }
  const card = A_CARD.exec(named)
  return card === null ? null : { card: Number(card[1]) }
}

export function stopReasonOf(words: string): string | null {
  const said = STOP_WORD.exec(words)
  return said === null ? null : said[1]!.trim()
}

function ownerStop(db: DatabaseSync, channel: string, now: Date, out: (line: string) => void, card: number, reason: string, toWindow: WindowRequest): number {
  sayToOwnerChannel(channel, ownerMoveCommand('stop', card), now)
  const request = toWindow(db, now.toISOString(), ANSWER_SESSION, { kind: 'owner.stop', card, reason, from: ANSWER_SOURCE })
  out(`${PREFIX}window.request ${request} (owner.stop #${card}) written with the owner's word and the reason "${reason}"; bus:run ends the live session of the card and its process group on its next tick, keeps its tree with the uncommitted changes, and records the stop with this reason, or refuses with why`)
  return 0
}

function openWaitNamed(db: DatabaseSync, target: Target): string | null {
  if ('id' in target)
    return ownerWaitOf(db, target.id)?.state === OPEN_WAIT ? target.id : null
  const waits = openWaitsOfCard(db, target.card)
  return waits.length === 1 ? waits[0]!.id : null
}

function askedMoveOfWait(db: DatabaseSync, target: Target): AskedOwnerMove | null {
  const id = openWaitNamed(db, target)
  if (id === null)
    return null
  const [opened] = events(db, { types: [OWNER_WAIT_OPENED], keys: [`${OWNER_WAIT_OPENED}:${id}`], limit: 1 })
  const asked = opened?.data?.command
  return askedOwnerMoveOf(typeof asked === 'string' ? asked : null)
}

function ownerMoveAnswered(db: DatabaseSync, channel: string, now: Date, out: (line: string) => void, answered: { target: Target, label: string, words: string }, asked: AskedOwnerMove, toWindow: WindowRequest): number {
  const { target, label, words } = answered
  const kind = String(asked.request.kind)
  sayToOwnerChannel(channel, ownerMoveCommand(asked.move, asked.target), now)
  const moved = toWindow(db, now.toISOString(), ANSWER_SESSION, { ...asked.request, reason: words, from: ANSWER_SOURCE })
  sayToOwnerChannel(channel, answerWord(label, words), now)
  const closing = toWindow(db, now.toISOString(), ANSWER_SESSION, { kind: 'owner.answer', ...target, text: words, from: ANSWER_SOURCE })
  out(`${PREFIX}window.request ${moved} (${kind} ${asked.target}) written with the owner's word, the move ${label} waits for; window.request ${closing} (owner.answer ${label}) closes the wait; bus:run executes both on its next tick, or refuses with why`)
  return 0
}

export function ownerWordsOf(said: readonly string[]): string {
  return said.join(' ').replace(TYPOGRAPHIC_QUOTES_AT_ENDS, '')
}

export function runOwnerAnswer(args: readonly string[], db: DatabaseSync, channel: string, now: Date, out: (line: string) => void, toWindow: WindowRequest): number {
  const [named, ...said] = args
  const target = named === undefined ? null : targetOf(named)
  const words = ownerWordsOf(said)
  if (target === null || words === '') {
    out(`${PREFIX}${USAGE}`)
    return 2
  }
  const label = 'id' in target ? target.id : `#${target.card}`
  const stop = 'card' in target ? stopReasonOf(words) : null
  if (stop !== null && 'card' in target)
    return ownerStop(db, channel, now, out, target.card, stop, toWindow)
  const asked = askedMoveOfWait(db, target)
  if (asked !== null)
    return ownerMoveAnswered(db, channel, now, out, { target, label, words }, asked, toWindow)
  sayToOwnerChannel(channel, answerWord(label, words), now)
  const request = toWindow(db, now.toISOString(), ANSWER_SESSION, { kind: 'owner.answer', ...target, text: words, from: ANSWER_SOURCE })
  out(`${PREFIX}window.request ${request} (owner.answer ${label}) written with the owner's word; bus:run answers it on its next tick with window.request.done (the wait closed, or continue-fixes written) or window.request.refused with the reason`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = withOwnerShellBus((db, channel) => runOwnerAnswer(process.argv.slice(2), db, channel, new Date(), line => console.log(line), requestFromWindow))
