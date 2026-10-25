import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath } from '../core/db.js'
import { busCardBodies } from '../intake/parking-reads.js'
import { cardNumberOf } from './approval.js'
import { handoffJournalPath, morseApprove } from './hash.js'

const USAGE = `usage: morse-approve.ts <brief> <card>; it writes only an approval by morse, an owner approval is pnpm approve`

interface MorseApproveArgs {
  briefPath: string
  card: number
}

export function morseApproveArgs(argv: string[]): MorseApproveArgs | string {
  const positional = argv
  if (positional.length !== 2 || positional.some(arg => arg.startsWith('-')))
    return USAGE
  const card = cardNumberOf(positional[1]!)
  if (card === undefined)
    return `card: expected a card number, got '${positional[1]}'\n${USAGE}`
  return { briefPath: positional[0]!, card }
}

async function main(): Promise<void> {
  const args = morseApproveArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exitCode = 1
    return
  }
  try {
    const approval = await morseApprove(args.briefPath, { card: args.card, cardBody: busCardBodies(defaultBusPath()), journalPath: handoffJournalPath(), now: new Date() })
    console.log(approval.line)
    if (approval.suggestion !== undefined)
      console.log(approval.suggestion)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
