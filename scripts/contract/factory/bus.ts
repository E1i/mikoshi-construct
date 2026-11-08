import type { EventWrites } from './payloads.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BUS_VERSION, BUS_VERSION_RECORD } from '../../core/bus-version.js'
import { openBus } from '../../core/db.js'
import { catalogueOf, writtenEvents } from './payloads.js'
import { parsedFiles } from './walk.js'

export interface BusSection {
  busVersion: number
  versionRecord: string
  events: Record<string, EventWrites>
  eventsOutsideTheCatalogue: Record<string, EventWrites>
  tables: Record<string, string[]>
}

const EVENTS_MODULE = 'scripts/core/events.ts'

function tablesOfAScratchBus(): Record<string, string[]> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'factory-bus-'))
  try {
    const db = openBus(path.join(scratch, 'bus.db'))
    try {
      const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'').all() as { name: string }[]
      return Object.fromEntries(tables.map(({ name }) => [name, (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(column => column.name).sort()]))
    }
    finally {
      db.close()
    }
  }
  finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function busSection(root: string): BusSection {
  const files = parsedFiles(root)
  const catalogue = files.find(({ file }) => file === EVENTS_MODULE)
  if (catalogue === undefined)
    throw new Error(`${EVENTS_MODULE} is not under ${root}, so the bus section has no event types to read`)
  const written = writtenEvents(files, catalogueOf(catalogue))
  return { busVersion: BUS_VERSION, versionRecord: BUS_VERSION_RECORD, events: written.events, eventsOutsideTheCatalogue: written.outsideTheCatalogue, tables: tablesOfAScratchBus() }
}
