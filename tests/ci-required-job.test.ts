import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REQUIRED_CHECK, SECRET_SCAN_CHECK } from '../scripts/ports/gh.js'
import { Meter } from '../scripts/ports/meter.js'
import { ciOf } from '../scripts/ports/snapshot.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const CI_WORKFLOW = '.github/workflows/ci.yml'
const HEAD = 'a'.repeat(40)

interface Job {
  needs?: string[]
  if?: string
}

async function renderedJobs(): Promise<Record<string, Job>> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-ci-required-'))
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, name: 'scratch', yes: true, dryRun: false, preset: 'node-library' })
  return (parse(readFileSync(path.join(dir, CI_WORKFLOW), 'utf8')) as { jobs: Record<string, Job> }).jobs
}

function meterOfGreenRuns(names: string[]): Meter {
  const checkRuns = names.map(name => ({ name, status: 'completed', conclusion: 'success' }))
  return new Meter(() => ({ status: 200, headers: {}, body: { check_runs: checkRuns } }), () => 0)
}

describe('the generated CI names one required check', () => {
  it('the required job needs every other job and runs whatever they ended with', async () => {
    const jobs = await renderedJobs()
    const others = Object.keys(jobs).filter(id => id !== REQUIRED_CHECK)
    expect(new Set(jobs[REQUIRED_CHECK]?.needs)).toEqual(new Set(others))
    expect(jobs[REQUIRED_CHECK]?.if).toBe('always()')
  })

  it('the bus reads a generated project green once every job and the secret scan pass', async () => {
    const jobs = await renderedJobs()
    expect(ciOf(meterOfGreenRuns([...Object.keys(jobs), SECRET_SCAN_CHECK]), HEAD)).toBe('green')
  })
})
