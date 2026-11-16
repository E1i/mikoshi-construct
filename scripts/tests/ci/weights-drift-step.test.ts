import type { TestWeights } from '../../ci/shard.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CI_REPORT_ARTIFACT, FILE_WEIGHTS_PATH, RECOMPUTE_DRIFTED_SHARE, WEIGHTS_PATH, weightsDrift } from '../../ci/test-weights.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const STEP_MODULE = 'scripts/ci/test-weights.ts'
const NODE_EVAL = /^node --import tsx --input-type=module -e '\n([\s\S]*)\n'\s*$/
const NOTICE = '::notice title=test weights drift::'
const RUN_TIMEOUT_MS = 60_000
const HELD_SECONDS = 10
const SHRUNK_SECONDS = 2.5
const FIXTURE_FILES = Array.from({ length: 16 }, (_, index) => `tests/fixture-${String(index).padStart(2, '0')}.test.ts`)
const SHRUNK_FILE = FIXTURE_FILES[0]!

interface Step { 'name'?: string, 'if'?: string, 'run'?: string, 'uses'?: string, 'continue-on-error'?: boolean, 'with'?: { name?: string } }

const steps = (parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: { required: { steps: Step[] } } }).jobs.required.steps
const uploadAt = steps.findIndex(step => step.with?.name === CI_REPORT_ARTIFACT)
const driftAt = steps.findIndex(step => step.run?.includes(NOTICE) === true)
const drift = steps[driftAt]

const table: TestWeights = Object.fromEntries(FIXTURE_FILES.map(file => [file, HELD_SECONDS]))
const measured: TestWeights = { ...table, [SHRUNK_FILE]: SHRUNK_SECONDS }

const roots: string[] = []

function treeWith(measurement: TestWeights | undefined): string {
  const root = mkdtempSync(path.join(tmpdir(), 'weights-drift-step-'))
  roots.push(root)
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'))
  mkdirSync(path.join(root, path.dirname(STEP_MODULE)), { recursive: true })
  symlinkSync(path.join(REPO_ROOT, STEP_MODULE), path.join(root, STEP_MODULE))
  writeFileSync(path.join(root, WEIGHTS_PATH), JSON.stringify(table))
  for (const file of FIXTURE_FILES) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), '')
  }
  if (measurement !== undefined) {
    mkdirSync(path.join(root, path.dirname(FILE_WEIGHTS_PATH)), { recursive: true })
    writeFileSync(path.join(root, FILE_WEIGHTS_PATH), JSON.stringify(measurement))
  }
  return root
}

function noticesIn(root: string): string[] {
  const script = NODE_EVAL.exec(drift?.run ?? '')?.[1]
  expect(script).toBeDefined()
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script!], { cwd: root, encoding: 'utf8', timeout: RUN_TIMEOUT_MS })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout.split('\n').filter(line => line.startsWith(NOTICE)).map(line => line.slice(NOTICE.length))
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('the report-merge job prints the test weights drift (D-600)', () => {
  it('prints it in the step right after the vitest-report upload, on the same push condition', () => {
    expect(uploadAt).toBeGreaterThan(-1)
    expect(driftAt).toBe(uploadAt + 1)
    expect(drift?.if).toBe(steps[uploadAt]!.if)
  })

  it('cannot fail the job', () => {
    expect(drift?.['continue-on-error']).toBe(true)
  })

  it('the fixture tells the measured line from a swapped comparison and from the 5% line', () => {
    const expected = weightsDrift(measured, table, RECOMPUTE_DRIFTED_SHARE)
    expect(RECOMPUTE_DRIFTED_SHARE).toBe(0.3)
    expect(expected.drifted).toEqual([SHRUNK_FILE])
    expect(expected.share).toBeGreaterThan(0)
    expect(expected.stale).toBe(false)
    expect(weightsDrift(table, measured, RECOMPUTE_DRIFTED_SHARE).line).not.toBe(expected.line)
    expect(weightsDrift(measured, table).line).not.toBe(expected.line)
  })

  it('prints the drift share of the fresh file-weights.json against the table at the 30% line, as written in ci.yml', () => {
    const expected = weightsDrift(measured, table, RECOMPUTE_DRIFTED_SHARE)
    const notices = noticesIn(treeWith(measured))
    expect(notices).toEqual([expected.line])
    expect(notices[0]).toContain(`${(expected.share * 100).toFixed(1)}% of the longest shard`)
    expect(notices[0]).toContain('within the 30% threshold')
  }, RUN_TIMEOUT_MS)

  it('prints why nothing was measured when the run left no file-weights.json', () => {
    const notices = noticesIn(treeWith(undefined))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(`no whole-file measurement file-weights.json at ${FILE_WEIGHTS_PATH}`)
  }, RUN_TIMEOUT_MS)
})
