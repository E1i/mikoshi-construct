import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Step { 'run'?: string, 'working-directory'?: string }
interface Job { strategy?: { matrix?: Record<string, unknown> }, steps: Step[] }

const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> }
const scripts = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

const SCRIPT_CALL = /^pnpm (?:run )?([\w:.-]+)(\s.*)?$/

function qualitySteps(): string[] {
  return scripts.quality!.split('&&').map((part) => {
    const match = SCRIPT_CALL.exec(part.trim())
    if (match == null || match[2] !== undefined)
      throw new Error(`the quality script has a step that is not a bare package script: ${part.trim()}`)
    return match[1]!
  })
}

interface Invocation { job: string, script: string, args: string }

function repositoryScriptInvocations(): Invocation[] {
  return Object.entries(workflow.jobs).flatMap(([job, { steps }]) => steps
    .filter(step => step.run != null && step['working-directory'] == null)
    .flatMap(step => step.run!.split('\n').map(line => line.trim()))
    .map(line => SCRIPT_CALL.exec(line))
    .filter(match => match != null && match[1]! in scripts)
    .map(match => ({ job, script: match![1]!, args: (match![2] ?? '').trim() })))
}

describe('the CI jobs run exactly the steps of package.json\'s quality', () => {
  const steps = qualitySteps()
  const invocations = repositoryScriptInvocations()

  it('reads a non-trivial gate from package.json', () => {
    expect(steps.length).toBeGreaterThan(3)
    expect(new Set(steps).size).toBe(steps.length)
  })

  for (const step of steps) {
    it(`runs ${step} in exactly one job`, () => {
      expect(invocations.filter(invocation => invocation.script === step)).toHaveLength(1)
    })
  }

  it('never runs the whole gate or its alias in this repository, so no step runs twice', () => {
    const aliases = Object.entries(scripts).filter(([, body]) => body.trim() === 'pnpm run quality').map(([name]) => name)
    expect(aliases).toContain('ci')
    for (const whole of ['quality', ...aliases])
      expect(invocations.filter(invocation => invocation.script === whole)).toEqual([])
  })

  it('runs every vitest shard, one per matrix leg', () => {
    const [test] = invocations.filter(invocation => invocation.script === 'test')
    const shard = /^--shard=\$\{\{ matrix\.shard \}\}\/(\d+)(?:\s|$)/.exec(test!.args)
    expect(shard).not.toBeNull()
    const total = Number(shard![1])
    expect(total).toBeGreaterThan(1)
    expect(workflow.jobs[test!.job]!.strategy?.matrix?.shard).toEqual(Array.from({ length: total }, (_, index) => index + 1))
  })
})
