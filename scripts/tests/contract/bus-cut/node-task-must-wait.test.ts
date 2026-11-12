import type { TaskMustWait } from '../../../core/task-must-wait.js'
import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { mustWait } from '../../../core/task-must-wait.js'
import { GitHubFailed, RateLimited } from '../../../ports/meter.js'

const NODE = 'scripts/core/node.ts'
const METER = 'scripts/ports/meter.ts'
const TASK_MUST_WAIT = 'scripts/core/task-must-wait.ts'

describe('the node waits on a bus contract, not on the meter', () => {
  it('repositoryReport() holds no import scripts/core/node.ts -> scripts/ports/meter.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.some(({ from, to }) => from === NODE && to === TASK_MUST_WAIT)).toBe(true)
    expect(graph.imports.filter(({ from, to }) => (from === NODE && to === METER) || (from === METER && to === TASK_MUST_WAIT))).toEqual([])
  })

  it('a rate limit from the meter is a task that must wait, carrying its retry-after', () => {
    const limited: TaskMustWait = new RateLimited(403, 120)
    expect(mustWait(limited)).toBe(true)
    expect(limited.retryAfterSeconds).toBe(120)
    expect(limited.message).toBe('GitHub answered 403; retry after 120 s')
  })

  it('a failure that is no rate limit, or a value that only looks like one, does not make the task wait', () => {
    expect(mustWait(new GitHubFailed(500, 'repos/o/r/pulls'))).toBe(false)
    expect(mustWait({ taskMustWait: true, retryAfterSeconds: 5, message: 'not an error' })).toBe(false)
    expect(mustWait(Object.assign(new Error('no seconds'), { taskMustWait: true }))).toBe(false)
  })
})
