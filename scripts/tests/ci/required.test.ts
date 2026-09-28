import type { JobResult, Needs } from '../../ci/required.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { blockingJobs, CLASSIFY_JOB, SKIPPED_ON_FAST_PATH } from '../../ci/required.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Job { name?: string, needs?: string | string[], if?: string, steps: { run?: string }[], outputs?: Record<string, string> }
const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> }
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

const OTHER_JOBS = ['checks', 'lint', 'typecheck', 'vitest', 'docs', 'package', 'contract-bump', 'acceptance']

const SKIPPED = Object.fromEntries(SKIPPED_ON_FAST_PATH.map(job => [job, 'skipped'])) as Record<string, JobResult>

function needs(fastPath: boolean, results: Partial<Record<string, JobResult>> = {}): Needs {
  return {
    [CLASSIFY_JOB]: { result: 'success', outputs: { 'fast-path': String(fastPath) } },
    ...Object.fromEntries(OTHER_JOBS.map(job => [job, { result: results[job] ?? 'success' }])),
  }
}

describe('the required verdict', () => {
  it('is green on the fast path with the preset matrix skipped', () => {
    expect(blockingJobs(needs(true, SKIPPED))).toEqual([])
  })

  it('is red when the package was skipped, on either path, since it no longer waits on the classification', () => {
    expect(blockingJobs(needs(true, { ...SKIPPED, package: 'skipped' }))).toEqual(['package: skipped'])
    expect(blockingJobs(needs(false, { package: 'skipped' }))).toEqual(['package: skipped'])
  })

  it('is red when the preset matrix was skipped on the full path', () => {
    expect(blockingJobs(needs(false, SKIPPED))).toEqual(['acceptance: skipped'])
    expect(blockingJobs(needs(false, { acceptance: 'skipped' }))).toEqual(['acceptance: skipped'])
  })

  it('is red when a preset job failed or was cancelled, whether or not the quality jobs passed', () => {
    expect(blockingJobs(needs(false, { acceptance: 'failure' }))).toEqual(['acceptance: failure'])
    expect(blockingJobs(needs(false, { acceptance: 'cancelled' }))).toEqual(['acceptance: cancelled'])
    expect(blockingJobs(needs(false, { lint: 'failure', acceptance: 'failure' }))).toEqual(['lint: failure', 'acceptance: failure'])
  })

  it('is red when one shard of vitest fails and the preset matrix passes', () => {
    expect(blockingJobs(needs(false, { vitest: 'failure' }))).toEqual(['vitest: failure'])
  })

  it('is red when a quality job fails on the fast path', () => {
    expect(blockingJobs(needs(true, { ...SKIPPED, docs: 'failure' }))).toEqual(['docs: failure'])
    expect(blockingJobs(needs(true, { ...SKIPPED, 'contract-bump': 'cancelled' }))).toEqual(['contract-bump: cancelled'])
  })

  it('accepts no skip other than the preset matrix on the fast path', () => {
    expect(blockingJobs(needs(true, { ...SKIPPED, 'checks': 'skipped', 'contract-bump': 'skipped' }))).toEqual(['checks: skipped', 'contract-bump: skipped'])
  })

  it('reads a quality job skipped on the full path as red', () => {
    expect(blockingJobs(needs(false, { typecheck: 'skipped', vitest: 'skipped' }))).toEqual(['typecheck: skipped', 'vitest: skipped'])
  })

  it('is red when the package failed and left the preset matrix skipped', () => {
    expect(blockingJobs(needs(false, { package: 'failure', acceptance: 'skipped' }))).toEqual(['package: failure', 'acceptance: skipped'])
  })

  it('is red when the classification itself failed', () => {
    expect(blockingJobs({ ...needs(false, SKIPPED), [CLASSIFY_JOB]: { result: 'failure', outputs: {} } })).toEqual([`${CLASSIFY_JOB}: failure`, 'acceptance: skipped'])
  })

  it('is red when it was given no job results', () => {
    expect(blockingJobs({})).toHaveLength(1)
  })
})

describe('ci.yml wiring', () => {
  it('makes required wait on every other job, whatever their results', () => {
    const others = Object.keys(workflow.jobs).filter(job => job !== 'required')
    expect(others.length).toBeGreaterThan(1)
    expect([workflow.jobs.required!.needs].flat().sort()).toEqual(others.sort())
    expect(workflow.jobs.required!.if).toBe('always()')
    expect(workflow.jobs.required!.steps.map(step => step.run ?? '').join('\n')).toContain('scripts/ci/verdict.ts')
  })

  it('skips only the preset matrix on the fast path, and the docs job runs the docs build on every change', () => {
    const conditional = Object.entries(workflow.jobs).filter(([, job]) => job.if !== undefined).map(([name]) => name)
    expect(conditional.sort()).toEqual([...SKIPPED_ON_FAST_PATH, 'required'].sort())
    for (const job of SKIPPED_ON_FAST_PATH)
      expect(workflow.jobs[job]!.if).toBe(`needs.${CLASSIFY_JOB}.outputs.fast-path != 'true'`)
    expect(workflow.jobs[CLASSIFY_JOB]!.outputs).toHaveProperty('fast-path')
    expect(workflow.jobs.docs!.steps.map(step => step.run ?? '')).toEqual(expect.arrayContaining(['pnpm docs:build', 'pnpm docs:pending']))
    expect(manifest.scripts.quality).toContain('pnpm docs:pending')
  })

  it('starts the preset matrix beside the quality jobs rather than after them', () => {
    const acceptanceNeeds = [workflow.jobs.acceptance!.needs].flat()
    expect(workflow.jobs.package!.needs).toBeUndefined()
    for (const job of ['checks', 'lint', 'typecheck', 'vitest', 'docs']) {
      expect(workflow.jobs[job]!.needs).toBeUndefined()
      expect(acceptanceNeeds).not.toContain(job)
    }
  })

  it('names no conditional job by a matrix expression, which a skipped job shows unexpanded', () => {
    const conditional = Object.values(workflow.jobs).filter(job => job.if !== undefined && job.if !== 'always()')
    expect(conditional.length).toBeGreaterThan(0)
    for (const job of conditional)
      expect(job.name ?? '').not.toContain('matrix.')
  })

  it('classifies a renamed file by both of its paths', () => {
    expect(workflow.jobs[CLASSIFY_JOB]!.steps.map(step => step.run ?? '').join('\n')).toContain('--no-renames')
  })
})
