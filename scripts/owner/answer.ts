import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { withOwnerShellBus } from '../policy/decisions/add.js'
import { ownerAnswerOf, writeAnswerRequest } from './answer-request.js'

export { answerWord } from './answer-request.js'

export const PREFIX = '[owner:answer] '

export const USAGE = 'usage: owner:answer <Q<N>|#<card>> "<the owner\'s words>"'

export function runOwnerAnswer(args: readonly string[], db: DatabaseSync, channel: string, now: Date, out: (line: string) => void): number {
  const [named, said] = args
  const answer = args.length === 2 ? ownerAnswerOf(named, said) : null
  if (answer === null) {
    out(`${PREFIX}${USAGE}`)
    return 2
  }
  const { request, label } = writeAnswerRequest(db, channel, answer, now)
  out(`${PREFIX}window.request ${request} (owner.answer ${label}) written with the owner's word; bus:run answers it on its next tick with window.request.done (the wait closed, or continue-fixes written) or window.request.refused with the reason`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = withOwnerShellBus((db, channel) => runOwnerAnswer(process.argv.slice(2), db, channel, new Date(), line => console.log(line)))
