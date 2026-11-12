import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { retryAfterSecondsIn } from '../../../core/task-must-wait.js'

const LEASE = 'scripts/core/lease.ts'
const METER = 'scripts/ports/meter.ts'
const TASK_MUST_WAIT = 'scripts/core/task-must-wait.ts'

describe('the lease reads the wait message from the bus contract', () => {
  it('repositoryReport() holds no import scripts/core/lease.ts -> scripts/ports/meter.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.some(({ from, to }) => from === LEASE && to === TASK_MUST_WAIT)).toBe(true)
    expect(graph.imports.filter(({ from, to }) => from === LEASE && to === METER)).toEqual([])
  })

  it('the contract reads the seconds a waiting task names, and nothing from a detail that names none', () => {
    expect(retryAfterSecondsIn('GitHub answered 429; retry after 75 s')).toBe(75)
    expect(retryAfterSecondsIn('GitHub answered 500 on repos/o/r/pulls')).toBeNull()
  })
})
