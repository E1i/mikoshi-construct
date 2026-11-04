import { spawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { scratchDir } from '../../scratch/run-root.js'
import { withActionsReporters } from '../../scratch/run.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const RUN = path.join(REPO_ROOT, 'scripts/scratch/run.ts')
const ON_ACTIONS: NodeJS.ProcessEnv = { GITHUB_ACTIONS: 'true' }
const ANNOTATING = ['--reporter=default', '--reporter=github-actions']

function runThroughWrapper(argv: string[], githubActions: string | undefined, bin: string): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_ACTIONS: githubActions }
  if (githubActions === undefined)
    delete env.GITHUB_ACTIONS
  return spawnSync(process.execPath, ['--import', 'tsx', RUN, ...argv], { cwd: REPO_ROOT, env, encoding: 'utf8' })
}

function vitestThatPrintsItsArgv(): string {
  const bin = scratchDir('fake-vitest-')
  const vitest = path.join(bin, 'vitest')
  writeFileSync(vitest, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n')
  chmodSync(vitest, 0o755)
  return bin
}

const printedArgv = (stdout: unknown): string[] => String(stdout).trim().split('\n')

describe('withActionsReporters', () => {
  it('adds the github-actions reporter beside the default to a vitest command on Actions', () => {
    expect(withActionsReporters(['vitest', 'run'], ON_ACTIONS)).toEqual(['vitest', ...ANNOTATING, 'run'])
  })

  it('adds the github-actions reporter ahead of the arguments pnpm test forwards, so one after a -- stays a filter', () => {
    expect(withActionsReporters(['vitest', 'run', '--shard=1/4', '--', 'a.test.ts'], ON_ACTIONS)).toEqual(['vitest', ...ANNOTATING, 'run', '--shard=1/4', '--', 'a.test.ts'])
  })

  const unchanged: Array<[string, string[], NodeJS.ProcessEnv]> = [
    ['a command naming --reporter=', ['vitest', 'run', '--reporter=blob'], ON_ACTIONS],
    ['a command naming --reporter and its value apart', ['vitest', 'run', '--reporter', 'blob'], ON_ACTIONS],
    ['the ci.yml shard command', ['vitest', 'run', '--shard=1/4', '--retry=1', '--reporter=default', '--reporter=github-actions', '--reporter=blob'], ON_ACTIONS],
    ['a command that is not vitest', ['pnpm', 'run', 'quality:steps'], ON_ACTIONS],
    ['a command only mentioning vitest', ['sh', '-c', 'vitest run'], ON_ACTIONS],
    ['a vitest command with GITHUB_ACTIONS unset', ['vitest', 'run'], {}],
    ['a vitest command with GITHUB_ACTIONS not true', ['vitest', 'run'], { GITHUB_ACTIONS: 'false' }],
  ]

  it.each(unchanged)('passes through %s', (_name, argv, env) => {
    expect(withActionsReporters(argv, env)).toEqual(argv)
  })
})

describe('run.ts, the wrapper pnpm test reaches vitest through', () => {
  it('adds the github-actions reporter to the vitest it spawns on Actions', () => {
    const result = runThroughWrapper(['vitest', 'run'], 'true', vitestThatPrintsItsArgv())
    expect(result.status, String(result.stderr)).toBe(0)
    expect(printedArgv(result.stdout)).toEqual([...ANNOTATING, 'run'])
  })

  it('passes through the vitest it spawns off Actions', () => {
    const result = runThroughWrapper(['vitest', 'run'], undefined, vitestThatPrintsItsArgv())
    expect(result.status, String(result.stderr)).toBe(0)
    expect(printedArgv(result.stdout)).toEqual(['run'])
  })

  it('passes through the vitest it spawns on Actions when the command names a reporter', () => {
    const result = runThroughWrapper(['vitest', 'run', '--reporter=blob'], 'true', vitestThatPrintsItsArgv())
    expect(result.status, String(result.stderr)).toBe(0)
    expect(printedArgv(result.stdout)).toEqual(['run', '--reporter=blob'])
  })

  it('reports a failing test of the real vitest as one error annotation on Actions', () => {
    const project = scratchDir('annotated-')
    writeFileSync(path.join(project, 'red.test.mjs'), `it('fails on purpose', () => { expect(1).toBe(2) })\n`)
    writeFileSync(path.join(project, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: { globals: true, include: ['red.test.mjs'] } })}\n`)

    const result = runThroughWrapper(['vitest', 'run', '--root', project, '--config', path.join(project, 'vitest.config.mjs')], 'true', path.join(REPO_ROOT, 'node_modules/.bin'))

    expect(result.status).toBe(1)
    expect(String(result.stdout).split('\n').filter(line => line.startsWith('::error') && line.includes('fails on purpose'))).toHaveLength(1)
  })
})
