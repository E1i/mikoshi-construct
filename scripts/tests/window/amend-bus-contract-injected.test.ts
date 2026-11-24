import type { RequestContext } from '../../window/requests/context.js'
import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../contract/module-graph/report.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { windowRequestBus } from '../../supervisor/composition.js'
import { execute } from '../../window/requests/amend.js'

const BUS_ADAPTER = 'scripts/core/bus-adapter.ts'
const WINDOW = 'scripts/window/'
const RUN = 'scripts/supervisor/run.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'

describe('the window takes the bus contract from the composition root', () => {
  it('repositoryReport() holds no import from scripts/window into scripts/core/bus-adapter.ts, and run.ts takes it from composition.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from.startsWith(WINDOW) && to === BUS_ADAPTER)).toEqual([])
    expect(graph.imports.filter(({ from, to }) => from === RUN && to === BUS_ADAPTER)).toEqual([])
    expect(graph.imports.some(({ from, to }) => from === RUN && to === COMPOSITION)).toBe(true)
    expect(graph.imports.some(({ from, to }) => from === COMPOSITION && to === BUS_ADAPTER)).toBe(true)
  })

  it('the composition root hands out the bus contract itself', () => {
    expect(windowRequestBus()).toBe(BUS_CONTRACT)
  })

  it('an amend on a request runner composed without the contract is refused and says why', () => {
    const context = { bus: null } as unknown as RequestContext
    expect(execute(context, 1, { kind: 'amend', card: 5 })).toEqual({ done: false, why: '#5: this request runner was composed without the bus contract; amend runs only under bus:run' })
  })
})
