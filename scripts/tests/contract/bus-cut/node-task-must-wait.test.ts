import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { TaskMustWait } from '../../../core/task-must-wait.js'
import { RateLimited } from '../../../ports/meter.js'

const NODE = 'scripts/core/node.ts'
const METER = 'scripts/ports/meter.ts'

describe('the node waits on a bus contract, not on the meter', () => {
  it('repositoryReport() holds no import scripts/core/node.ts -> scripts/ports/meter.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.some(({ from }) => from === NODE)).toBe(true)
    expect(graph.imports.filter(({ from, to }) => from === NODE && to === METER)).toEqual([])
  })

  it('a rate limit from the meter is a task that must wait, carrying its retry-after', () => {
    const limited = new RateLimited(403, 120)
    expect(limited).toBeInstanceOf(TaskMustWait)
    expect(limited.retryAfterSeconds).toBe(120)
    expect(limited.message).toBe('GitHub answered 403; retry after 120 s')
  })
})
