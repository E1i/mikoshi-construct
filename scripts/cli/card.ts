import type { DatabaseSync } from 'node:sqlite'
import type { CardBody, Contract } from '../intake/card-contract.js'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { CARD_BODIES } from '../core/card-bodies.js'
import { cardChain } from './card-chain.js'
import { cardFields, contractOf, CONTRACTS, isContract } from '../intake/card-contract.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { lastHeartbeat } from '../supervisor/heartbeat.js'
import { openDatabase } from '../core/sqlite.js'

export const PREFIX = '[card] '
export const USAGE = `usage: pnpm card <N> (--contract <${CONTRACTS.join('|')}> | --md | --chain)`

const CARD_NUMBER = /^#?([1-9]\d*)$/
const BODY_OF_CARD = `
  SELECT body.admission_event_id, body.text, body.text_sha, body.lane, cards.state
  FROM ${CARD_BODIES} body LEFT JOIN cards ON cards.card_id = body.card_id
  WHERE body.card_id = ?
`

export interface CardDeps {
  bus: string
  out: (text: string) => void
  err: (line: string) => void
}

type Request = { kind: 'contract', card: number, contract: Contract } | { kind: 'md', card: number } | { kind: 'chain', card: number }

interface BodyRow { admission_event_id: number, text: string, text_sha: string, lane: string | null, state: string | null }

function requestOf(args: string[]): Request | string {
  const [number, flag, contract, ...rest] = args
  const card = CARD_NUMBER.exec(number ?? '')?.[1]
  if (card === undefined || rest.length > 0)
    return USAGE
  if (flag === '--md' && contract === undefined)
    return { kind: 'md', card: Number(card) }
  if (flag === '--chain' && contract === undefined)
    return { kind: 'chain', card: Number(card) }
  if (flag !== '--contract' || contract === undefined)
    return USAGE
  return isContract(contract) ? { kind: 'contract', card: Number(card), contract } : `no contract ${contract}; ${USAGE}`
}

function holdsBodies(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(CARD_BODIES) !== undefined
}

function readBodies<T>(bus: string, read: (db: DatabaseSync) => T | null): T | null {
  if (!existsSync(bus))
    return null
  const db = openDatabase(bus, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return holdsBodies(db) ? read(db) : null
  }
  finally {
    db.close()
  }
}

function bodyOf(bus: string, card: number): CardBody | null {
  return readBodies(bus, (db) => {
    const row = db.prepare(BODY_OF_CARD).get(card) as BodyRow | undefined
    return row === undefined ? null : { admissionEventId: row.admission_event_id, text: row.text, textSha: row.text_sha, lane: row.lane, state: row.state, lastHeartbeat: lastHeartbeat(db, card) }
  })
}

export function runCard(args: string[], deps: CardDeps): number {
  const request = requestOf(args)
  if (typeof request === 'string') {
    deps.err(`${PREFIX}${request}`)
    return 2
  }
  const chain = request.kind === 'chain' ? readBodies(deps.bus, db => cardChain(db, request.card)) : null
  if (chain !== null) {
    deps.out(`${JSON.stringify(chain, null, 2)}\n`)
    return 0
  }
  const body = bodyOf(deps.bus, request.card)
  if (body === null) {
    deps.err(`${PREFIX}card #${request.card} has no admitted text in ${CARD_BODIES} of ${deps.bus}; admit it through pnpm intake --admit, then run pnpm bus:reduce`)
    return 1
  }
  if (request.kind !== 'contract') {
    deps.out(body.text)
    return 0
  }
  const parsed = parseParkingFile(`${request.card}.md`, body.text)
  if (parsed.kind === 'refused') {
    deps.err(`${PREFIX}card #${request.card}: the admitted text is refused by the card grammar: ${parsed.reason}`)
    return 1
  }
  deps.out(`${JSON.stringify(contractOf(cardFields(parsed.parked, body), request.contract), null, 2)}\n`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCard(process.argv.slice(2), {
    bus: defaultBusPath(),
    out: text => process.stdout.write(text),
    err: line => console.error(line),
  })
}
