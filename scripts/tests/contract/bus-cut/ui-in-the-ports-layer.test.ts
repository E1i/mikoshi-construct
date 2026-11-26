import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../../contract/factory/modules.js'
import { boundaryNumbers, boundaryReport } from '../../../contract/module-graph/boundary.js'
import { RATCHET_RECORD, readRatchet } from '../../../contract/ratchet.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const REPORT_TIMEOUT = 180_000

const ROWS_INTO_THE_PORTS_LAYER = [
  'boundary:intake->ui',
  'boundary:bus->ui',
  'boundary:node-close->ui',
  'boundary:ports->ui',
  'boundary:ports->command-registry',
]

const MOVED_MODULES = ['ui', 'command-registry']

function declaredLayer(module: string): string {
  return (JSON.parse(readFileSync(path.join(REPO_ROOT, 'declarations', 'modules', `${module}.json`), 'utf8')) as { layer: string }).layer
}

describe('ui and command-registry sit in the ports layer', () => {
  it('both are declared in the ports layer', () => {
    for (const module of MOVED_MODULES)
      expect(declaredLayer(module), module).toBe('ports')
  })

  it('every module ranked above ports may use ui and command-registry, and they use nothing above layout', () => {
    expect(MODULE_GRAPH.modules['command-registry']?.may_use).toEqual(['layout'])
    expect(MODULE_GRAPH.modules.ui?.may_use).toEqual(['layout', 'command-registry'])
    for (const module of ['ports-adapters', 'ports', 'events', 'bus', 'intake', 'node-close'])
      expect(MODULE_GRAPH.modules[module]?.may_use, module).toEqual(expect.arrayContaining(MOVED_MODULES))
  })

  it('the imports into the ports layer count 0 and their rows are gone from the ratchet', { timeout: REPORT_TIMEOUT }, () => {
    const measured = boundaryNumbers(boundaryReport(REPO_ROOT).violations)
    const recorded = readRatchet(REPO_ROOT)

    for (const row of ROWS_INTO_THE_PORTS_LAYER) {
      expect(measured[row] ?? 0, `${row} measured`).toBe(0)
      expect(Object.keys(recorded), `${row} in ${RATCHET_RECORD}`).not.toContain(row)
    }
  })
})
