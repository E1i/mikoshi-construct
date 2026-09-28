import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/watch-fixtures/world.sh')
const WATCH = path.join(REPO_ROOT, 'scripts/ghosts/watch.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

const KINDS = ['base', 'stale', 'alive', 'no-ledger', 'no-tool', 'no-report', 'near-tool', 'far-tool', 'no-row']

const createdWorlds: string[] = []

function world(...args: string[]): string {
  const result = spawnSync('bash', [WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  return result.stdout.trim()
}

function newWorld(kind: string): string {
  const w = world('new', kind)
  createdWorlds.push(w)
  return w
}

function runFor(w: string, seconds: number, extraArgs: string[]): void {
  world('run-for', w, String(seconds), process.execPath, TSX_CLI, WATCH, ...extraArgs)
}

afterEach(() => {
  while (createdWorlds.length > 0) {
    const w = createdWorlds.pop()!
    world('clean', w)
  }
})

describe('ghosts watch, end to end through the stub', () => {
  it.each(KINDS)('shows one frame naming the report age, last tool, ledger stage and process state for kind %s', (kind) => {
    const w = newWorld(kind)
    runFor(w, 30, ['--tasks', path.join(w, 'tasks.json')])
    world('check-once', w)
  })

  it('redraws with --every until it is interrupted', () => {
    const w = newWorld('base')
    runFor(w, 8, ['--tasks', path.join(w, 'tasks.json'), '--every', '1'])
    world('check-every', w)
  })

  it('writes nothing anywhere over several frames, with a live session', () => {
    const w = newWorld('alive')
    runFor(w, 8, ['--tasks', path.join(w, 'tasks.json'), '--every', '1'])
    world('check-every', w)
    world('check-readonly', w)
  })

  it('refuses --every 0, naming --every', () => {
    const w = newWorld('base')
    runFor(w, 30, ['--tasks', path.join(w, 'tasks.json'), '--every', '0'])
    world('check-refused', w, '--every')
  })

  it.each([
    { args: (w: string) => ['--tasks', path.join(w, 'tasks.json'), '--evry', '5'], word: '--evry' },
    { args: (_w: string) => ['--tasks', '--every', '2'], word: '--tasks' },
    { args: (w: string) => ['--tasks', path.join(w, 'tasks.json'), '--every'], word: '--every' },
  ])('refuses an unknown flag or a flag used as a value, naming $word', ({ args, word }) => {
    const w = newWorld('base')
    runFor(w, 30, args(w))
    world('check-refused', w, word)
  })

  it('refuses a missing --tasks, naming --tasks', () => {
    const w = newWorld('base')
    runFor(w, 30, [])
    world('check-refused', w, '--tasks')
  })

  it('reads the tasks file through readTasksFile, refusing an unknown key by name', () => {
    expect(spawnSync('grep', ['-q', 'readTasksFile', WATCH]).status).toBe(0)
    const w = newWorld('base')
    runFor(w, 30, ['--tasks', path.join(w, 'tasks-bogus.json')])
    world('check-refused', w, 'bogus')
  })

  it('carries the prefix on every printed line, in a frame and in a refusal', () => {
    const w = newWorld('base')
    runFor(w, 30, ['--tasks', path.join(w, 'tasks.json')])
    world('check-prefix', w)

    runFor(w, 30, [])
    world('check-refused', w, '--tasks')
    world('check-prefix', w)
  })
})
