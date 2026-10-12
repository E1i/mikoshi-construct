import type { DatabaseSync } from 'node:sqlite'
import type { CardEvent, CardEventPort } from '../../src/commands/intake/index.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMain } from 'citty'
import { parseParkingFile } from '../../src/card/parking.js'
import { isLaneName } from '../../src/commands/intake/admit.js'
import { CARD_ADMITTED, CARD_MOVED } from '../../src/commands/intake/index.js'
import { createMain } from '../../src/program.js'
import { INTAKE_ACTOR_PREFIX } from './admissions.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'

const INTAKE_SUBCOMMAND = 'intake'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SESSION_BY_HAND = 'by-hand'

function append(db: DatabaseSync, actor: string, event: CardEvent): void {
  appendEvent(db, { ts: event.ts, type: event.type, actor, cardId: event.cardId, pr: null, head: null, dedupeKey: event.dedupeKey, payload: event.payload, legacy: false })
}

function admissionOfMove(move: CardEvent): CardEvent | null {
  const { lane, to } = move.payload
  if (typeof lane !== 'string' || !isLaneName(lane) || typeof to !== 'string')
    return null
  const file = path.join(to, `${move.cardId}.md`)
  if (!existsSync(file))
    return null
  const parsed = parseParkingFile(path.basename(file), readFileSync(file, 'utf8'))
  if (parsed.kind === 'refused')
    return null
  const { card } = parsed.parked.task
  return {
    type: CARD_ADMITTED,
    cardId: move.cardId,
    ts: move.ts,
    dedupeKey: `${CARD_ADMITTED}:${move.dedupeKey}`,
    payload: { card: card.line, lane, depends: card.depends, decision: card.decision, contour: card.contour, moved: move.dedupeKey },
  }
}

export function busCardEvents(db: DatabaseSync, session: string = SESSION_BY_HAND): CardEventPort {
  const actor = `${INTAKE_ACTOR_PREFIX}${session}`
  return (event) => {
    append(db, actor, event)
    const admitted = event.type === CARD_MOVED ? admissionOfMove(event) : null
    if (admitted !== null)
      append(db, actor, admitted)
  }
}

async function main(): Promise<void> {
  const db = openBus(defaultBusPath())
  try {
    await runMain(createMain({ cardEvents: busCardEvents(db, process.env[SESSION_VARIABLE] || undefined) }), { rawArgs: [INTAKE_SUBCOMMAND, ...process.argv.slice(2)] })
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
