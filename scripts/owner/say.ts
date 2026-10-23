import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ownerChannelOf, sayToOwnerChannel } from './channel.js'

export const PREFIX = '[owner:say] '
export const USAGE = 'usage: pnpm owner:say "<the owner\'s words>"'

export function runOwnerSay(args: readonly string[], channel: string, now: Date, out: (line: string) => void): number {
  if (args.length !== 1 || args[0]!.trim() === '' || args[0]!.startsWith('--')) {
    out(`${PREFIX}${USAGE}`)
    return 2
  }
  out(`${PREFIX}${sayToOwnerChannel(channel, args[0]!, now)}`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runOwnerSay(process.argv.slice(2), ownerChannelOf(os.homedir()), new Date(), line => console.log(line))
