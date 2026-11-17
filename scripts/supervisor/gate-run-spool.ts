import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { appendEvent, inTransaction } from '../core/db.js'
import { GATE_RUN } from '../core/events.js'

export interface SpoolPlaces {
  homes: readonly string[]
  spool: string
}

export interface KeptLine {
  line: number
  why: string
}

export interface SpoolImport {
  file: string
  imported: number
  again: number
  kept: KeptLine[]
}

type Reading = { event: BusEvent } | { why: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function numberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number'
}

export function gateRunOfLine(line: string): Reading {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  }
  catch (error) {
    return { why: `not JSON (${messageOf(error)})` }
  }
  if (!isRecord(parsed) || parsed.type !== GATE_RUN)
    return { why: `not a ${GATE_RUN} event` }
  const { ts, actor, cardId, pr, head, dedupeKey, payload } = parsed
  if (typeof ts !== 'string' || typeof actor !== 'string' || typeof dedupeKey !== 'string' || !numberOrNull(cardId) || !numberOrNull(pr) || !textOrNull(head) || !isRecord(payload))
    return { why: `a ${GATE_RUN} event missing ts, actor, dedupeKey or payload, or with a field of the wrong type` }
  const spooled = { ...parsed, legacy: false } as BusEvent
  return { event: spooled }
}

export function spoolsUnder(places: SpoolPlaces): string[] {
  const homes = [...new Set(places.homes.map(home => path.resolve(home)))]
  return homes.flatMap((home) => {
    if (!existsSync(home))
      return []
    let trees: string[]
    try {
      trees = readdirSync(home, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(home, entry.name))
    }
    catch {
      return []
    }
    return trees.map(tree => path.join(tree, places.spool)).filter(file => existsSync(file))
  })
}

function textOf(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

function leaveTheRest(file: string, read: string, keptLines: readonly string[]): void {
  const now = textOf(file) ?? ''
  if (!now.startsWith(read))
    return
  const remaining = [...keptLines.map(line => `${line}\n`), now.slice(read.length)].join('')
  if (remaining === '')
    rmSync(file, { force: true })
  else
    writeFileSync(file, remaining)
}

export function importSpool(db: DatabaseSync, file: string): SpoolImport {
  const read = textOf(file) ?? ''
  const complete = read.endsWith('\n') ? read : read.slice(0, read.lastIndexOf('\n') + 1)
  const lines = complete.split('\n')
  const kept: KeptLine[] = []
  const keptLines: string[] = []
  const counted = inTransaction(db, () => {
    let imported = 0
    let again = 0
    lines.forEach((line, index) => {
      if (line.trim() === '')
        return
      const reading = gateRunOfLine(line)
      let why = 'why' in reading ? reading.why : null
      if ('event' in reading) {
        try {
          if (appendEvent(db, reading.event))
            imported++
          else
            again++
        }
        catch (error) {
          why = `the bus refused it (${messageOf(error)})`
        }
      }
      if (why !== null) {
        kept.push({ line: index + 1, why })
        keptLines.push(line)
      }
    })
    return { imported, again }
  })
  leaveTheRest(file, complete, keptLines)
  return { file, ...counted, kept }
}

export function spoolLines(outcome: SpoolImport, prefix: string): string[] {
  const lines: string[] = []
  if (outcome.imported + outcome.again > 0)
    lines.push(`${prefix}${GATE_RUN} spool ${outcome.file}: imported ${outcome.imported}, already on the bus ${outcome.again}`)
  for (const { line, why } of outcome.kept)
    lines.push(`${prefix}${GATE_RUN} spool ${outcome.file}: line ${line} left in place, ${why}`)
  return lines
}

export class GateRunSpool {
  constructor(private readonly db: DatabaseSync, private readonly places: SpoolPlaces, private readonly prefix: string) {}

  step(): string[] {
    return spoolsUnder(this.places).flatMap((file) => {
      try {
        return spoolLines(importSpool(this.db, file), this.prefix)
      }
      catch (error) {
        return [`${this.prefix}${GATE_RUN} spool ${file}: not imported this tick, it stays in place (${messageOf(error)})`]
      }
    })
  }
}
