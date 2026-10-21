import type { DatabaseSync } from 'node:sqlite'
import type { Queue } from './identifiers.js'
import type { Equivalence } from './node.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NODE_EQUIVALENCE } from '../core/events.js'
import { defaultBusPath, openBus } from './db.js'
import { QUEUES } from './identifiers.js'

export const PREFIX = '[bus:node-equivalence] '
export const USAGE = `${PREFIX}usage: pnpm bus:node-equivalence <${QUEUES.join('|')}> [--since <ISO time>]`

export interface EquivalenceWindow {
  ticks: number
  diverged: number
  onlyNode: Map<string, number>
  onlyDerive: Map<string, number>
}

const TICKS_OF_KIND = `SELECT payload FROM events WHERE type = ? AND substr(actor, 1, ?) = ? AND ts >= ? ORDER BY id`

function count(into: Map<string, number>, keys: readonly string[]): void {
  for (const key of keys)
    into.set(key, (into.get(key) ?? 0) + 1)
}

export function equivalenceWindow(db: DatabaseSync, kind: Queue, since: string): EquivalenceWindow {
  const actorPrefix = `worker:${kind}:`
  const rows = db.prepare(TICKS_OF_KIND).all(NODE_EQUIVALENCE, actorPrefix.length, actorPrefix, since) as { payload: string }[]
  const window: EquivalenceWindow = { ticks: 0, diverged: 0, onlyNode: new Map(), onlyDerive: new Map() }
  for (const row of rows) {
    const tick = JSON.parse(row.payload) as Equivalence
    window.ticks += 1
    if (tick.only_node.length > 0 || tick.only_derive.length > 0)
      window.diverged += 1
    count(window.onlyNode, tick.only_node)
    count(window.onlyDerive, tick.only_derive)
  }
  return window
}

function keyLines(side: string, keys: Map<string, number>): string[] {
  return [...keys].sort(([a], [b]) => a.localeCompare(b)).map(([key, ticks]) => `${PREFIX}${side} ${key} in ${ticks} tick(s)`)
}

export function equivalenceText(kind: Queue, since: string, window: EquivalenceWindow): string[] {
  const period = since === '' ? 'over the whole log' : `since ${since}`
  return [
    `${PREFIX}${kind} ${period}: ${window.ticks} tick(s), ${window.diverged} with a divergence`,
    ...keyLines('only_node', window.onlyNode),
    ...keyLines('only_derive', window.onlyDerive),
  ]
}

function isQueue(value: string | undefined): value is Queue {
  return value !== undefined && (QUEUES as readonly string[]).includes(value)
}

function sinceOf(argv: string[]): string {
  const index = argv.indexOf('--since')
  return index === -1 ? '' : argv[index + 1] ?? ''
}

export function runNodeEquivalence(db: DatabaseSync, argv: string[], out: (line: string) => void): number {
  const kind = argv[0]
  if (!isQueue(kind)) {
    out(USAGE)
    return 1
  }
  const since = sinceOf(argv)
  const window = equivalenceWindow(db, kind, since)
  for (const line of equivalenceText(kind, since, window))
    out(line)
  return window.diverged === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openBus(defaultBusPath())
  try {
    process.exitCode = runNodeEquivalence(db, process.argv.slice(2), line => console.log(line))
  }
  finally {
    db.close()
  }
}
