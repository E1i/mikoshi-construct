import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { nodeLiveness } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'

const LEASE = 'scripts/core/lease.ts'
const NODE = 'scripts/core/node.ts'
const LIVENESS_SITES = 'scripts/supervisor/liveness-sites.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'

describe('the lease takes its silence window from its caller', () => {
  it('repositoryReport() holds no import scripts/core/lease.ts -> scripts/supervisor/liveness-sites.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => (from === LEASE || from === NODE) && to === LIVENESS_SITES)).toEqual([])
    expect(graph.imports.some(({ from, to }) => from === COMPOSITION && to === LIVENESS_SITES)).toBe(true)
  })

  it('the composition fills the node parts with the silence window of the liveness sites', () => {
    expect(nodeLiveness()).toEqual({ silentMs: SILENT_MS })
  })
})
