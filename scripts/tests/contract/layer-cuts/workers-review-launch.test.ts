import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { REVIEW_INSTANCE_FILE, reviewLaunch } from '../../../supervisor/composition.js'
import { busLaunches, wantedLaunches, workerLaunches } from '../../../supervisor/workers.js'

const WORKERS = 'scripts/supervisor/workers.ts'
const REVIEW_BG = 'scripts/supervisor/review-bg.ts'
const SUPERVISOR = 'scripts/supervisor/supervisor.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const NOWHERE = '/nonexistent-bus-dir'

describe('the worker registry takes the review launch from its root', () => {
  it('repositoryReport() holds no import scripts/supervisor/workers.ts -> scripts/supervisor/review-bg.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from === WORKERS && to === REVIEW_BG)).toEqual([])
    expect(graph.imports.filter(({ from, to }) => from === WORKERS && to === COMPOSITION)).toEqual([])
    expect(graph.imports.some(({ from, to }) => from === SUPERVISOR && to === COMPOSITION)).toBe(true)
    expect(graph.imports.some(({ from, to }) => from === REVIEW_BG && to === COMPOSITION)).toBe(true)
  })

  it('the review launch the registry hands out is the one its caller gave', () => {
    const review = reviewLaunch(() => ['a problem'])
    expect(workerLaunches(review).review).toBe(review)
    expect(busLaunches(review)).toContain(review)
    expect(review.instanceFile).toBe(REVIEW_INSTANCE_FILE)
    expect(review.preflight?.()).toEqual(['a problem'])
    expect(wantedLaunches(NOWHERE, review).map(launch => launch.script)).not.toContain(review.script)
  })
})
