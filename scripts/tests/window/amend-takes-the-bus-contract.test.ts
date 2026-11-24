import type { RequestContext } from '../../window/requests/context.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { boundaryNumbers, boundaryReport } from '../../contract/module-graph/boundary.js'
import { repositoryReport } from '../../contract/module-graph/report.js'
import { readRatchet } from '../../contract/ratchet.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { windowRequestBus } from '../../supervisor/composition.js'
import { execute } from '../../window/requests/amend.js'

const BUS_ADAPTER = 'scripts/core/bus-adapter.ts'
const WINDOW = 'scripts/window/'
const RUN = 'scripts/supervisor/run.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const WINDOW_TO_BUS = 'boundary:window->bus'
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

describe('the window takes the bus contract from the composition root', () => {
  it('amend requests take the bus contract from the root, so scripts/window imports nothing from core/bus-adapter and window->bus drops by that edge in the graph and the ratchet', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from.startsWith(WINDOW) && to === BUS_ADAPTER)).toEqual([])
    expect(graph.imports.filter(({ from, to }) => from === RUN && to === BUS_ADAPTER)).toEqual([])
    expect(graph.imports.some(({ from, to }) => from === RUN && to === COMPOSITION)).toBe(true)
    expect(graph.imports.some(({ from, to }) => from === COMPOSITION && to === BUS_ADAPTER)).toBe(true)
    expect(readRatchet(REPO_ROOT)[WINDOW_TO_BUS]).toBe(boundaryNumbers(boundaryReport(REPO_ROOT).violations)[WINDOW_TO_BUS])
  })

  it('the composition root hands out the bus contract itself', () => {
    expect(windowRequestBus()).toBe(BUS_CONTRACT)
  })

  it('an amend on a request runner composed without the contract is refused and says why', () => {
    const context = { bus: null } as unknown as RequestContext
    expect(execute(context, 1, { kind: 'amend', card: 5 })).toEqual({ done: false, why: '#5: this request runner was composed without the bus contract; amend runs only under bus:run' })
  })
})
