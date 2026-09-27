import type { Manifest } from '../src/manifest.js'
import type { RepositoryModel } from '../src/model/schema.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runInit } from '../src/commands/init.js'
import { readManifest } from '../src/manifest.js'
import { MODEL_FILE, parseModel } from '../src/model/schema.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const FOREIGN_HARNESS = 'make check'
const DEFAULT_HARNESS = 'pnpm run quality'
const HARNESS_STEPS = 'harness-steps'
const CI_WORKFLOW = '.github/workflows/ci.yml'

interface Workflow {
  jobs: Record<string, { steps: { run?: string }[] }>
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-init-harness-'))
}

async function init(dir: string, options: { preset?: string, harness?: string } = { preset: 'node-library' }): Promise<void> {
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, name: 'scratch', yes: true, dryRun: false, ...options })
}

function manifestOf(dir: string): Manifest {
  return readManifest(dir)!
}

function modelOf(dir: string): RepositoryModel {
  return parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE)
}

function ciRuns(dir: string): string[] {
  const workflow = parse(readFileSync(path.join(dir, CI_WORKFLOW), 'utf8')) as Workflow
  return Object.values(workflow.jobs).flatMap(job => job.steps.flatMap(step => step.run ?? []))
}

describe('init takes the harness command from --harness', () => {
  it('records the --harness command in construct.json and the CI workflow runs it', async () => {
    const dir = scratch()
    await init(dir, { preset: 'node-library', harness: FOREIGN_HARNESS })
    expect(manifestOf(dir).harness.command).toBe(FOREIGN_HARNESS)
    expect(ciRuns(dir)).toContain(FOREIGN_HARNESS)
  })

  it('keeps the recorded command on a second init without --harness', async () => {
    const dir = scratch()
    await init(dir, { preset: 'node-library', harness: FOREIGN_HARNESS })
    await init(dir, {})
    expect(manifestOf(dir).harness.command).toBe(FOREIGN_HARNESS)
  })

  it('writes no harness-steps claim and no claim naming the default command when the harness is foreign', async () => {
    const dir = scratch()
    await init(dir, { preset: 'node-library', harness: FOREIGN_HARNESS })
    const claims = modelOf(dir).claims
    expect(claims.map(claim => claim.id)).not.toContain(HARNESS_STEPS)
    expect(claims.filter(claim => JSON.stringify(claim).includes(DEFAULT_HARNESS)).map(claim => claim.id)).toEqual([])
  })

  it('without --harness and without a record assumes pnpm run quality and writes the harness-steps claim', async () => {
    const dir = scratch()
    await init(dir)
    expect(manifestOf(dir).harness.command).toBe(DEFAULT_HARNESS)
    expect(modelOf(dir).claims.map(claim => claim.id)).toContain(HARNESS_STEPS)
  })
})
