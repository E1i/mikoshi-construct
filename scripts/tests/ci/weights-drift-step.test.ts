import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CI_REPORT_ARTIFACT, RECOMPUTE_DRIFTED_SHARE } from '../../ci/test-weights.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const NODE_EVAL = /^node --import tsx --input-type=module -e '\n([\s\S]*)\n'\s*$/
const NOTICE = '::notice title=test weights drift::'
const RUN_TIMEOUT_MS = 60_000

interface Step { 'name'?: string, 'if'?: string, 'run'?: string, 'uses'?: string, 'continue-on-error'?: boolean, 'with'?: { name?: string } }

const steps = (parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: { required: { steps: Step[] } } }).jobs.required.steps
const uploadAt = steps.findIndex(step => step.with?.name === CI_REPORT_ARTIFACT)
const driftAt = steps.findIndex(step => step.run?.includes(NOTICE) === true)
const drift = steps[driftAt]

describe('the report-merge job prints the test weights drift (D-600)', () => {
  it('prints it in the step right after the vitest-report upload, on the same push condition', () => {
    expect(uploadAt).toBeGreaterThan(-1)
    expect(driftAt).toBe(uploadAt + 1)
    expect(drift?.if).toBe(steps[uploadAt]!.if)
  })

  it('cannot fail the job', () => {
    expect(drift?.['continue-on-error']).toBe(true)
  })

  it('measures against the recompute line the bus admits a card at', () => {
    expect(RECOMPUTE_DRIFTED_SHARE).toBe(0.3)
    expect(drift?.run).toContain('weightsDrift(measurement.weights, table, RECOMPUTE_DRIFTED_SHARE)')
    expect(drift?.run).not.toMatch(/\b0\.3\b/)
  })

  it('runs as written in this repository and prints one notice', () => {
    const script = NODE_EVAL.exec(drift?.run ?? '')?.[1]
    expect(script).toBeDefined()
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script!], { cwd: REPO_ROOT, encoding: 'utf8', timeout: RUN_TIMEOUT_MS })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout.split('\n').filter(line => line.startsWith(NOTICE))).toHaveLength(1)
  }, RUN_TIMEOUT_MS)
})
