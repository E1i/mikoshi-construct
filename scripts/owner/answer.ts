import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ownerMoveCommand } from '../core/owner-commands.js'
import { withOwnerShellBus } from '../policy/decisions/add.js'
import { ANSWER_SOURCE, requestFromWindow } from '../policy/decisions/window-door.js'
import { sayToOwnerChannel } from './channel.js'

export const PREFIX = '[owner:answer] '
export const ANSWER_SESSION = 'owner-answer'
export const ANSWER_WORD = 'answer'
const A_WAIT = /^Q\d+$/
const A_CARD = /^#?(\d+)$/
const STOP_WORD = /^stop:\s*(\S[\s\S]*)$/i

export const USAGE = 'usage: construct-answer <Q<N>|#<card>> "<the owner\'s words>"'

export function answerWord(target: string, words: string): string {
  return `${ANSWER_WORD} ${target}: ${words}`
}

function targetOf(named: string): { id: string } | { card: number } | null {
  if (A_WAIT.test(named))
    return { id: named }
  const card = A_CARD.exec(named)
  return card === null ? null : { card: Number(card[1]) }
}

export function stopReasonOf(words: string): string | null {
  const said = STOP_WORD.exec(words)
  return said === null ? null : said[1]!.trim()
}

function ownerStop(db: DatabaseSync, channel: string, now: Date, out: (line: string) => void, card: number, reason: string): number {
  sayToOwnerChannel(channel, ownerMoveCommand('stop', card), now)
  const request = requestFromWindow(db, now.toISOString(), ANSWER_SESSION, { kind: 'owner.stop', card, reason, from: ANSWER_SOURCE })
  out(`${PREFIX}window.request ${request} (owner.stop #${card}) written with the owner's word and the reason "${reason}"; bus:run ends the live session of the card and its process group on its next tick, keeps its tree with the uncommitted changes, and records the stop with this reason, or refuses with why`)
  return 0
}

export function runOwnerAnswer(args: readonly string[], db: DatabaseSync, channel: string, now: Date, out: (line: string) => void): number {
  const [named, said] = args
  const target = named === undefined ? null : targetOf(named)
  const words = said?.trim() ?? ''
  if (args.length !== 2 || target === null || words === '' || words.startsWith('--')) {
    out(`${PREFIX}${USAGE}`)
    return 2
  }
  const label = 'id' in target ? target.id : `#${target.card}`
  const stop = 'card' in target ? stopReasonOf(words) : null
  if (stop !== null && 'card' in target)
    return ownerStop(db, channel, now, out, target.card, stop)
  sayToOwnerChannel(channel, answerWord(label, words), now)
  const request = requestFromWindow(db, now.toISOString(), ANSWER_SESSION, { kind: 'owner.answer', ...target, text: words, from: ANSWER_SOURCE })
  out(`${PREFIX}window.request ${request} (owner.answer ${label}) written with the owner's word; bus:run answers it on its next tick with window.request.done (the wait closed, or continue-fixes written) or window.request.refused with the reason`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = withOwnerShellBus((db, channel) => runOwnerAnswer(process.argv.slice(2), db, channel, new Date(), line => console.log(line)))
