import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import YAML from 'yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Step { uses?: string, run?: string, with?: { path?: string, key?: string } }

function jobSteps(workflowFile: string, job: string): Step[] {
  const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, workflowFile), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
  return workflow.jobs[job]!.steps
}

function installIndexOf(steps: Step[]): number {
  return steps.findIndex(step => step.run?.includes('playwright-core install') === true)
}

function cacheIndexOf(steps: Step[]): number {
  return steps.findIndex(step => step.uses?.startsWith('actions/cache@') === true)
}

const steps = jobSteps('.github/workflows/ci.yml', 'browser')
const extensionSteps = jobSteps('.github/workflows/browser-lab.yml', 'extension')
const lab = readFileSync(path.join(REPO_ROOT, 'scripts/construct/browser-lab.mjs'), 'utf8')

function exportedPin(name: string): string {
  const pin = new RegExp(`^export const ${name} = '([^']+)'$`, 'm').exec(lab)?.[1]
  if (pin === undefined)
    throw new Error(`scripts/construct/browser-lab.mjs exports no string constant ${name}`)
  return pin
}

const PLAYWRIGHT_CORE = exportedPin('PLAYWRIGHT_CORE')
const PLAYWRIGHT_CLI = exportedPin('PLAYWRIGHT_CLI')

const installIndex = installIndexOf(steps)
const install = steps[installIndex]?.run ?? ''

it('the browser job restores the playwright browsers and the npm cache before its install under a key naming both pinned versions', () => {
  expect(installIndex).toBeGreaterThan(-1)
  const cacheIndex = cacheIndexOf(steps)
  expect(cacheIndex).toBeGreaterThan(-1)
  expect(cacheIndex).toBeLessThan(installIndex)

  const cache = steps[cacheIndex]!.with!
  expect(cache.path!.trim().split('\n')).toEqual(['~/.cache/ms-playwright', '~/.construct/browser-lab/npm-cache'])
  expect(cache.key).toContain(PLAYWRIGHT_CORE)
  expect(cache.key).toContain(PLAYWRIGHT_CLI)
})

it('the browser job installs chromium without apt dependencies', () => {
  expect(install).toContain(`--package ${PLAYWRIGHT_CORE} -c 'playwright-core install chromium'`)
  expect(install).toContain(`--package ${PLAYWRIGHT_CLI} -c 'playwright-cli install-browser chromium'`)
  expect(install).not.toContain('--with-deps')
})

it('the browser-lab extension job has the same cache step and installs without apt dependencies', () => {
  const extensionInstallIndex = installIndexOf(extensionSteps)
  const extensionCacheIndex = cacheIndexOf(extensionSteps)
  expect(extensionCacheIndex).toBeGreaterThan(-1)
  expect(extensionCacheIndex).toBeLessThan(extensionInstallIndex)

  expect(extensionSteps[extensionCacheIndex]).toEqual(steps[cacheIndexOf(steps)])
  expect(extensionSteps[extensionInstallIndex]!.run).toBe(install)
  expect(extensionSteps[extensionInstallIndex]!.run).not.toContain('--with-deps')
})
