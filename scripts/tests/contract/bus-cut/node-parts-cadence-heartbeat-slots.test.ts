import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { CHECK_MS, TICK_MS } from '../../../ports/netwatch.js'
import { nodeSupply } from '../../../supervisor/composition.js'
import { slotsOf } from '../../../supervisor/scheduler.js'

const NODE = 'scripts/core/node.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const FILLERS = ['scripts/ports/netwatch.ts', 'scripts/supervisor/heartbeat.ts', 'scripts/supervisor/scheduler.ts']
const WORKER_ENTRIES = [
  ...['answer', 'close', 'merge', 'review', 'update', 'witness'].map(name => `scripts/nodes/${name}/${name}-worker.ts`),
  'scripts/nodes/launch/launch-root.ts',
]

describe('the node takes cadence, heartbeat and slots from its parts', () => {
  it('node.ts and the worker entries import none of netwatch, heartbeat or scheduler; the entries take the parts from the composition module', () => {
    const { graph } = repositoryReport()
    const intoFillers = graph.imports.filter(({ from, to }) => (from === NODE || WORKER_ENTRIES.includes(from)) && FILLERS.includes(to))
    expect(intoFillers).toEqual([])
    const fromComposition = new Set(graph.imports.filter(({ to }) => to === COMPOSITION).map(({ from }) => from))
    expect(WORKER_ENTRIES.filter(entry => !fromComposition.has(entry))).toEqual([])
  })

  it('the composition module fills the parts with the cadence and slots their readers already use', () => {
    const supply = nodeSupply()
    expect(supply.cadence).toEqual({ checkMs: CHECK_MS, tickMs: TICK_MS })
    for (const kind of ['launch', 'witness', 'answer', 'review', 'merge', 'update', 'close'] as const)
      expect(supply.slotsOf(kind, {})).toBe(slotsOf(kind, {}))
  })
})
