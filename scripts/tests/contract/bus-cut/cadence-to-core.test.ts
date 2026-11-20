import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'

const REPO_RUN_TIMEOUT = 180_000

const CADENCE = 'scripts/core/cadence.ts'
const NETWATCH = 'scripts/ports/netwatch.ts'
const SUPERVISOR_ROOTS_OF_NETWATCH = new Set(['scripts/supervisor/run.ts', 'scripts/supervisor/composition.ts', 'scripts/supervisor/netwatch-root.ts'])
const VIOLATING_IMPORTS_AFTER_THE_MOVE = 1076

function importsNetwatchOutsideItsRoots(from: string): boolean {
  return from.startsWith('scripts/nodes/') || (from.startsWith('scripts/supervisor/') && !SUPERVISOR_ROOTS_OF_NETWATCH.has(from))
}

describe('the cadence constants live in session', () => {
  it('scripts/core/cadence.ts is held by session, no node and no supervisor file but its roots imports netwatch, and violations fall', { timeout: REPO_RUN_TIMEOUT }, () => {
    const report = repositoryReport()

    expect(report.files.find(({ file }) => file === CADENCE)?.holder).toBe('session')
    expect(report.graph.imports.filter(({ from, to }) => to === NETWATCH && importsNetwatchOutsideItsRoots(from)).map(({ from }) => from)).toEqual([])
    expect(report.statistics.violatingImports).toBeLessThanOrEqual(VIOLATING_IMPORTS_AFTER_THE_MOVE)
  })
})
