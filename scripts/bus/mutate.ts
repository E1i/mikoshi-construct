import type { MutationJudgedPort } from '../../src/commands/mutate/journal.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMain } from 'citty'
import { createMain } from '../../src/program.js'
import { GHOST_LINE } from '../core/events.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { cardIdOf } from './identifiers.js'
import { busIntakePorts } from './intake.js'

const MUTATE_SUBCOMMAND = 'mutate'
const MUTATE_WRITER = 'mutate-judge'

export function busMutationJudged(busPath: string): MutationJudgedPort {
  return (line) => {
    const db = openBus(busPath)
    try {
      appendEvent(db, { ts: line.ts, type: GHOST_LINE, actor: `worker:${MUTATE_WRITER}:${process.pid}`, cardId: cardIdOf(line.card), pr: null, head: null, dedupeKey: `${GHOST_LINE}:${randomUUID()}`, payload: line, legacy: false })
    }
    finally {
      db.close()
    }
    return busPath
  }
}

async function main(): Promise<void> {
  const db = openBus(defaultBusPath())
  try {
    await runMain(createMain({ ...busIntakePorts(db), mutationJudged: busMutationJudged(defaultBusPath()) }), { rawArgs: [MUTATE_SUBCOMMAND, ...process.argv.slice(2)] })
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
