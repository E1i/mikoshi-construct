import type { PresetId } from '../src/presets/index.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { availablePresets } from '../scripts/harness-command/render.js'
import { REQUIRED_CHECK, SECRET_SCAN_CHECK } from '../scripts/ports/gh.js'
import { Meter } from '../scripts/ports/meter.js'
import { ciOf } from '../scripts/ports/snapshot.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const CI_WORKFLOW = '.github/workflows/ci.yml'
const HEAD = 'a'.repeat(40)
const EVERY_NEEDED_RESULT = /^\$\{\{ join\(needs\.\*\.result, ' '\) \}\}$/

const EXIT_OF_RESULTS: Record<string, number> = {
  'success': 0,
  'success success': 0,
  'failure': 1,
  'cancelled': 1,
  'skipped': 1,
  'success failure': 1,
  'failure success': 1,
}

interface Step {
  env?: Record<string, string>
  run?: string
}

interface Job {
  needs?: string[]
  if?: string
  steps: Step[]
}

async function renderedJobs(preset: PresetId): Promise<Record<string, Job>> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-ci-required-'))
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, name: 'scratch', yes: true, dryRun: false, preset })
  return (parse(readFileSync(path.join(dir, CI_WORKFLOW), 'utf8')) as { jobs: Record<string, Job> }).jobs
}

function meterOfGreenRuns(names: string[]): Meter {
  const checkRuns = names.map(name => ({ name, status: 'completed', conclusion: 'success' }))
  return new Meter(() => ({ status: 200, headers: {}, body: { check_runs: checkRuns } }), () => 0)
}

function verdictStep(jobs: Record<string, Job>): Step {
  const step = jobs[REQUIRED_CHECK]?.steps.find(candidate => candidate.run !== undefined)
  if (step === undefined)
    throw new Error(`${REQUIRED_CHECK} has no step that runs`)
  return step
}

function exitOf(step: Step, results: string): number | null {
  return spawnSync('bash', ['-c', step.run!], { env: { ...process.env, RESULTS: results }, encoding: 'utf8' }).status
}

describe('the generated CI names one required check', () => {
  for (const preset of availablePresets()) {
    it(`${preset}: the required job needs every other job and runs whatever they ended with`, async () => {
      const jobs = await renderedJobs(preset)
      const others = Object.keys(jobs).filter(id => id !== REQUIRED_CHECK)
      expect(new Set(jobs[REQUIRED_CHECK]?.needs)).toEqual(new Set(others))
      expect(jobs[REQUIRED_CHECK]?.if).toBe('always()')
      expect(verdictStep(jobs).env?.RESULTS).toMatch(EVERY_NEEDED_RESULT)
    })

    it(`${preset}: the bus reads a generated project green once every job and the secret scan pass`, async () => {
      const jobs = await renderedJobs(preset)
      expect(ciOf(meterOfGreenRuns([...Object.keys(jobs), SECRET_SCAN_CHECK]), HEAD)).toBe('green')
    })
  }

  it('the required step passes only when every needed job succeeded', async () => {
    const step = verdictStep(await renderedJobs('node-library'))
    for (const [results, exit] of Object.entries(EXIT_OF_RESULTS))
      expect(exitOf(step, results), results).toBe(exit)
  })
})
