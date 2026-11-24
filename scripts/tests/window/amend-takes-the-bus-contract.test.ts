import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

interface ReportImport { from: string, to: string }
interface ReportViolation { fromModule: string, toHolder: string }
interface ModuleGraphReport { graph: { imports: ReportImport[] }, violations: ReportViolation[] }

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const REPORT_SCRIPT = 'scripts/contract/module-graph/report.ts'
const RATCHET_RECORD = 'contract/ratchet.json'
const REPORT_BUFFER_BYTES = 64 * 1024 * 1024
const REPORT_TIMEOUT_MS = 120_000
const BUS_ADAPTER = 'scripts/core/bus-adapter.ts'
const WINDOW = 'scripts/window/'
const RUN = 'scripts/supervisor/run.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const WINDOW_TO_BUS = 'boundary:window->bus'

function moduleGraphReport(): ModuleGraphReport {
  const output = execFileSync(process.execPath, ['--import', 'tsx', REPORT_SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: REPORT_BUFFER_BYTES })
  return JSON.parse(output) as ModuleGraphReport
}

function windowToBusViolations(report: ModuleGraphReport): number | undefined {
  const count = report.violations.filter(({ fromModule, toHolder }) => fromModule === 'window' && toHolder === 'bus').length
  return count === 0 ? undefined : count
}

describe('the window takes the bus contract from the composition root', () => {
  it('amend requests take the bus contract from the root, so scripts/window imports nothing from core/bus-adapter and window->bus drops by that edge in the graph and the ratchet', { timeout: REPORT_TIMEOUT_MS }, () => {
    const report = moduleGraphReport()
    const imports = report.graph.imports
    expect(imports.filter(({ from, to }) => from.startsWith(WINDOW) && to === BUS_ADAPTER)).toEqual([])
    expect(imports.filter(({ from, to }) => from === RUN && to === BUS_ADAPTER)).toEqual([])
    expect(imports.some(({ from, to }) => from === RUN && to === COMPOSITION)).toBe(true)
    expect(imports.some(({ from, to }) => from === COMPOSITION && to === BUS_ADAPTER)).toBe(true)
    const ratchet = JSON.parse(readFileSync(path.join(REPO_ROOT, RATCHET_RECORD), 'utf8')) as Record<string, number>
    expect(ratchet[WINDOW_TO_BUS]).toBe(windowToBusViolations(report))
  })
})
