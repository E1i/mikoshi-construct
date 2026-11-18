import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'

const REPO_RUN_TIMEOUT = 180_000

const CORE_PR_STATUS = 'scripts/core/pr-status.ts'
const PORTS_PR_STATUS = 'scripts/ports/pr-status.ts'
const OPERATOR_WORK = 'scripts/window/operator-work.ts'
const VIOLATING_IMPORTS_AFTER_THE_MOVE = 1077

describe('the pure pr-status step lives in pr-record', () => {
  it('scripts/core/pr-status.ts is held by pr-record and imports nothing from window or ports; ports/pr-status.ts no longer reads the window', { timeout: REPO_RUN_TIMEOUT }, () => {
    const report = repositoryReport()

    expect(report.files.find(({ file }) => file === CORE_PR_STATUS)?.holder).toBe('pr-record')
    expect(report.graph.imports.filter(({ from, to }) => from === CORE_PR_STATUS && (to.startsWith('scripts/window/') || to.startsWith('scripts/ports/')))).toEqual([])
    expect(report.graph.imports.filter(({ from, to }) => from === PORTS_PR_STATUS && to === OPERATOR_WORK)).toEqual([])
    expect(report.statistics.violatingImports).toBeLessThanOrEqual(VIOLATING_IMPORTS_AFTER_THE_MOVE)
  })
})
