import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const RATCHET = 'contract/ratchet.json'
const BOUNDARY = 'boundary:'

const WITNESSES = 'scripts/ports/witnesses.ts'
const MOVED_MODULES = ['ports', 'quality', 'intake', 'card-record', 'card-model']
const REMOVED_ROW = 'boundary:ports->quality'
const PORTS_INTAKE = 'boundary:ports->intake'
const PORTS_INTAKE_CEILING = 2

const BASE_ROWS: Readonly<Record<string, number>> = {
  'boundary:bus->card-model': 1,
  'boundary:card-model->card-record': 1,
  'boundary:card-model->plan': 1,
  'boundary:card-record->intake': 7,
  'boundary:card-record->plan': 1,
  'boundary:card-record->quality': 2,
  'boundary:card-record->rules': 1,
  'boundary:card-record->session': 2,
  'boundary:ports->bus': 5,
  'boundary:ports->card-model': 3,
  'boundary:ports->card-record': 2,
  'boundary:ports->cost': 1,
  'boundary:ports->events': 2,
  'boundary:ports->intake': 3,
  'boundary:ports->pr-record': 1,
  'boundary:ports->project': 9,
  'boundary:ports->quality': 1,
  'boundary:ports->session': 4,
  'boundary:ports->window': 1,
  'boundary:project->ports': 1,
  'boundary:quality->composition-root': 2,
  'boundary:quality->intake': 1,
  'boundary:session->intake': 2,
  'boundary:session->quality': 1,
}

interface Declaration {
  module: string
  paths: string[]
}

function json<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T
}

function endsOf(row: string): string[] {
  return row.slice(BOUNDARY.length).split('->')
}

describe('scripts/ports/witnesses.ts runs in quality, the witness shape lives in card', () => {
  it('ports->quality is gone from contract/ratchet.json, ports->intake is at most 2 and no row grew', () => {
    const ratchet = json<Record<string, number>>(RATCHET)
    const touched = Object.entries(ratchet).filter(([row]) => row.startsWith(BOUNDARY) && endsOf(row).some(end => MOVED_MODULES.includes(end)))

    expect(ratchet[REMOVED_ROW], REMOVED_ROW).toBeUndefined()
    expect(ratchet[PORTS_INTAKE] ?? 0, PORTS_INTAKE).toBeLessThanOrEqual(PORTS_INTAKE_CEILING)
    for (const [row, count] of touched)
      expect(count, row).toBeLessThanOrEqual(BASE_ROWS[row] ?? 0)
  })

  it('the quality declaration names the witnesses reader', () => {
    expect(json<Declaration>('declarations/modules/quality.json').paths).toContain(WITNESSES)
  })
})
