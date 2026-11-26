import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const REPORT_SCRIPT = path.join(REPO_ROOT, 'scripts/contract/module-graph/report.ts')
const FACTORY_CONTRACT = 'contract/factory.json'
const RATCHET_RECORD = 'contract/ratchet.json'
const REPORT_TIMEOUT = 180_000
const REPORT_OUTPUT_LIMIT = 1 << 30

const ROWS_INTO_THE_PORTS_LAYER = [
  'boundary:intake->ui',
  'boundary:bus->ui',
  'boundary:node-close->ui',
  'boundary:ports->ui',
  'boundary:ports->command-registry',
]

const MOVED_MODULES = ['ui', 'command-registry']

interface ReportedViolation {
  fromModule: string
  toHolder: string
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T
}

function declaredLayer(module: string): string {
  return readJson<{ layer: string }>(path.join('declarations', 'modules', `${module}.json`)).layer
}

function mayUseOf(module: string): string[] | undefined {
  return readJson<{ modules: { modules: Record<string, { may_use: string[] }> } }>(FACTORY_CONTRACT).modules.modules[module]?.may_use
}

function measuredBoundaryRows(): Record<string, number> {
  const output = execFileSync(process.execPath, ['--import', 'tsx', REPORT_SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: REPORT_OUTPUT_LIMIT })
  const rows: Record<string, number> = {}
  for (const { fromModule, toHolder } of (JSON.parse(output) as { violations: ReportedViolation[] }).violations) {
    const row = `boundary:${fromModule}->${toHolder.replaceAll(' ', '-')}`
    rows[row] = (rows[row] ?? 0) + 1
  }
  return rows
}

describe('ui and command-registry sit in the ports layer', () => {
  it('both are declared in the ports layer', () => {
    for (const module of MOVED_MODULES)
      expect(declaredLayer(module), module).toBe('ports')
  })

  it('every module ranked above ports may use ui and command-registry, and they use nothing above layout', () => {
    expect(mayUseOf('command-registry')).toEqual(['layout'])
    expect(mayUseOf('ui')).toEqual(['layout', 'command-registry'])
    for (const module of ['ports-adapters', 'ports', 'events', 'bus', 'intake', 'node-close'])
      expect(mayUseOf(module), module).toEqual(expect.arrayContaining(MOVED_MODULES))
  })

  it('the imports into the ports layer count 0 and their rows are gone from the ratchet', { timeout: REPORT_TIMEOUT }, () => {
    const measured = measuredBoundaryRows()
    const recorded = readJson<Record<string, number>>(RATCHET_RECORD)

    for (const row of ROWS_INTO_THE_PORTS_LAYER) {
      expect(measured[row] ?? 0, `${row} measured`).toBe(0)
      expect(Object.keys(recorded), `${row} in ${RATCHET_RECORD}`).not.toContain(row)
    }
  })
})
