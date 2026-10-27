import type { Prompter } from '../../../src/ui/prompts.js'
import type { Lease } from '../../core/lease.js'
import type { GhResponse } from '../../ports/github.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAttachRecord, runAttach } from '../../../src/commands/attach/index.js'
import { createUi, silentWriter } from '../../../src/ui/console.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { useIsolatedHome } from '../../../tests/isolated-home.js'
import { openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { freshDenial } from '../../nodes/review/record-verdict.js'
import { recordDecision } from '../../policy/decisions.js'
import { Meter } from '../../ports/meter.js'
import { NetWatch, NETWATCH_SCRIPT } from '../../ports/netwatch.js'
import { ciOf, requiredCheckOf } from '../../ports/snapshot.js'
import { Clock, FakeGitHub, sha } from '../bus/github-fake.js'
import { liveBench } from '../bus/merge-bench.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()

afterEach(() => {
  vi.restoreAllMocks()
})

const WORKFLOW = [
  'jobs:',
  '  build:',
  '    name: Build and test',
  '    steps:',
  '      - run: pnpm test',
  '',
].join('\n')

function repository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-required-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(path.join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(path.join(dir, '.github/workflows/ci.yml'), WORKFLOW)
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'host', private: true, scripts: { test: 'vitest run' } }))
  return dir
}

function choosingFirst(): Prompter {
  return {
    preset: () => Promise.resolve(undefined),
    aiTarget: () => Promise.resolve(undefined),
    projectName: () => Promise.resolve(undefined),
    review: () => Promise.resolve(undefined),
    lanes: () => Promise.resolve(3),
    harnessCommand: candidates => Promise.resolve(candidates[0]),
    confirm: () => Promise.resolve(true),
  }
}

function meterOf(runs: { name: string, status: string, conclusion: string | null }[]): Meter {
  const respond = (): GhResponse => ({ status: 200, headers: {}, body: { check_runs: runs } })
  return new Meter(respond, () => 0)
}

describe('attach records the job of the gate candidate and the bus reads it as the required check', () => {
  it('writes the job name into attach.json', async () => {
    const dir = repository()

    expect((await runAttach(ui, { dir, yes: false }, choosingFirst())).status).toBe('done')

    expect(readAttachRecord(dir)?.harness).toEqual({ command: 'pnpm test', job: 'Build and test' })
    expect(requiredCheckOf(dir)).toBe('Build and test')
  })

  it('reads green under attach.json when the check run of that job is success', async () => {
    const dir = repository()
    await runAttach(ui, { dir, yes: false }, choosingFirst())
    const meter = meterOf([{ name: 'Build and test', status: 'completed', conclusion: 'success' }])

    expect(ciOf(meter, 'a'.repeat(40), requiredCheckOf(dir))).toBe('green')
    expect(ciOf(meter, 'a'.repeat(40))).toBe('pending')
  })

  it('keeps the check named required when attach recorded no job', async () => {
    const dir = repository()
    writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'name: ci\n')
    expect((await runAttach(ui, { dir, yes: false }, choosingFirst())).status).toBe('done')

    expect(readAttachRecord(dir)?.harness).not.toHaveProperty('job')
    expect(requiredCheckOf(dir)).toBe('required')
  })

  it('netwatch observes ci from the recorded job, not from the check named required', async () => {
    const attached = repository()
    await runAttach(ui, { dir: attached, yes: false }, choosingFirst())
    const plain = repository()
    const observedCi = (root: string): unknown => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bus-attach-required-'))
      const db = openBus(path.join(dir, 'bus.db'))
      const gitHub = new FakeGitHub()
      gitHub.open({ number: 900, review: 'success' })
      new NetWatch(db, gitHub.client, new Clock().now, NETWATCH_SCRIPT, root).poll()
      const row = db.prepare('SELECT payload FROM events WHERE type = ?').get('pr.observed')
      db.close()
      return (JSON.parse(String(row?.payload)) as { ci: unknown }).ci
    }

    expect(observedCi(plain)).toBe('green')
    expect(observedCi(attached)).toBe('pending')
  })
})

async function attachedRepository(): Promise<string> {
  const dir = repository()
  await runAttach(ui, { dir, yes: false }, choosingFirst())
  return dir
}

function watching(dir: string): void {
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
}

describe('the bus reads the recorded job from the root of the repository it watches', () => {
  it('requiredCheckOf without a root reads attach.json of the working directory repository', async () => {
    const dir = await attachedRepository()
    watching(dir)

    expect(requiredCheckOf()).toBe('Build and test')
  })

  it('requiredCheckOf without a root finds the repository root from a subdirectory', async () => {
    const dir = await attachedRepository()
    mkdirSync(path.join(dir, 'packages/app'), { recursive: true })
    watching(path.join(dir, 'packages/app'))

    expect(requiredCheckOf()).toBe('Build and test')
  })

  it('requiredCheckOf without a root keeps the check named required in a repository attach.json does not name a job for', () => {
    watching(repository())

    expect(requiredCheckOf()).toBe('required')
  })

  it('the review verdict freshness check passes on the recorded job and holds on the check named required', async () => {
    const gitHub = new FakeGitHub()
    gitHub.checkName = 'Build and test'
    gitHub.open({ number: 951, review: 'success' })
    const lease = { pr: 951, head: sha('a') } as Lease

    watching(await attachedRepository())
    expect(freshDenial(gitHub.client, lease, () => 0)).toBeNull()

    watching(repository())
    expect(freshDenial(gitHub.client, lease, () => 0)).toMatchObject({ kind: 'technical', reason: 'ci_not_ready' })
  })

  it('the merge executor merges on the recorded job and waits on the check named required', async () => {
    const attached = await attachedRepository()
    const plain = repository()
    const outcome = (mergingFrom: string): unknown => {
      watching(attached)
      const bench = liveBench()
      bench.gitHub.checkName = 'Build and test'
      recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: 121, text: '[owner] allow-live merge', cards: [] })
      reduce(bench.db)
      bench.gitHub.open({ number: 960, review: 'success' })
      bench.tick()
      const lease = bench.lease()!
      watching(mergingFrom)
      const merged = bench.merge(lease)
      bench.close()
      return merged
    }

    expect(outcome(attached)).toMatchObject({ kind: 'merged' })
    expect(outcome(plain)).toMatchObject({ kind: 'denied', denial: { reason: 'ci_not_ready' } })
  })
})
