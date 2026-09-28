import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Step { 'name'?: string, 'if'?: string, 'run'?: string, 'working-directory'?: string }
const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
const steps = workflow.jobs.acceptance!.steps
const stepNamed = (name: string) => steps.findIndex(step => step.name === name)

describe('the minimumReleaseAge acceptance leg', () => {
  it('writes the policy into pnpm-workspace.yaml, the only place pnpm 12 reads it, and never into .npmrc', () => {
    const apply = steps[stepNamed('Apply the release-age policy')]!
    expect(apply.run).toContain('minimumReleaseAge:')
    expect(apply.run).toContain('pnpm-workspace.yaml')
    expect(steps.some(step => step.run?.includes('.npmrc'))).toBe(false)
  })

  it('proves the policy refuses a fresh version before the project installs', () => {
    const apply = stepNamed('Apply the release-age policy')
    const probe = stepNamed('The release-age policy refuses a version younger than it')
    const install = stepNamed('pnpm install')
    expect(apply).toBeLessThan(probe)
    expect(probe).toBeLessThan(install)
    expect(steps[probe]!.if).toBe(steps[apply]!.if)
    expect(steps[probe]!.run).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION')
  })
})
