import type { LayerMap } from '../core/layer-map.js'
import process from 'node:process'
import { isTest } from '../../src/card/covering-tests.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { isDocument, layersInOf, readLayerMap } from '../core/layer-map.js'
import { openDatabase } from '../core/sqlite.js'

export const NO_LAYER_SINCE = '2026-11-03'

const NO_LAYER_PHRASE = 'belongs to no layer'
const NAMED_FILE = /([^\s"'`:;]+) belongs to no layer of the (?:check catalog|dependency graph)/
const EVENTS_NAMING_NO_LAYER = `SELECT type, payload FROM events WHERE ts >= ? AND instr(payload, ?) > 0 ORDER BY id`

export type Placement = 'docs' | 'test' | 'layer' | 'full'

export interface NoLayerEvent { type: string, payload: string }

export interface Recount { events: number, notFull: number, byPlacement: Record<Placement, number>, byType: Record<string, { events: number, notFull: number }> }

export function placementOf(file: string | null, map: LayerMap): Placement {
  if (file === null)
    return 'full'
  if (isDocument(file))
    return 'docs'
  if (isTest(file))
    return 'test'
  return layersInOf(map, file).length > 0 ? 'layer' : 'full'
}

export function fileNamedIn(payload: string): string | null {
  return NAMED_FILE.exec(payload)?.[1] ?? null
}

export function recount(events: readonly NoLayerEvent[], map: LayerMap): Recount {
  const byPlacement: Record<Placement, number> = { docs: 0, test: 0, layer: 0, full: 0 }
  const byType: Recount['byType'] = {}
  for (const { type, payload } of events) {
    const placement = placementOf(fileNamedIn(payload), map)
    byPlacement[placement] += 1
    const row = byType[type] ??= { events: 0, notFull: 0 }
    row.events += 1
    row.notFull += placement === 'full' ? 0 : 1
  }
  return { events: events.length, notFull: events.length - byPlacement.full, byPlacement, byType }
}

function main(): void {
  const db = openDatabase(process.argv[2] ?? defaultBusPath(), { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const events = db.prepare(EVENTS_NAMING_NO_LAYER).all(process.argv[3] ?? NO_LAYER_SINCE, NO_LAYER_PHRASE) as unknown as NoLayerEvent[]
    console.log(JSON.stringify(recount(events, readLayerMap()), null, 2))
  }
  finally {
    db.close()
  }
}

if (process.argv[1] === import.meta.filename)
  main()
