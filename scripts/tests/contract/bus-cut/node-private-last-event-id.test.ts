import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'

const NODE = 'scripts/core/node.ts'
const OPERATOR_WORK = 'scripts/window/operator-work.ts'

describe('the node reads the last event id without the window', () => {
  it('repositoryReport() holds no import scripts/core/node.ts -> scripts/window/operator-work.ts and no module edge bus>window', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from === NODE && to === OPERATOR_WORK)).toEqual([])
    expect(graph.modules.filter(({ from, to }) => from === 'bus' && to === 'window')).toEqual([])
  })
})
