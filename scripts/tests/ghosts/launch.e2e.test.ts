import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')

function world(...args: string[]): string {
  const result = spawnSync('bash', [WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  return result.stdout.trim()
}

function launch(worldDir: string, answer: string): { status: number | null } {
  const bin = path.join(worldDir, 'bin')
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), LAUNCH, '--tasks', path.join(worldDir, 'tasks.json')], {
    input: `${answer}\n`,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  writeFileSync(path.join(worldDir, 'launch.out'), `${result.stdout}${result.stderr}`)
  return { status: result.status }
}

describe('ghosts launch, end to end through the stub', () => {
  it('does nothing without the yes confirmation', () => {
    const w = world('new', 'ok')
    const { status } = launch(w, 'no')
    expect(status).not.toBe(0)
    world('check-decision', w)
    world('check-untouched', w)
  })

  it('refuses a tampered brief before any listing', () => {
    const w = world('new', 'tampered')
    const { status } = launch(w, 'yes')
    expect(status).not.toBe(0)
    world('check-refused', w)
    world('check-untouched', w)
  })

  it('refuses an unapproved brief before any listing', () => {
    const w = world('new', 'unapproved')
    const { status } = launch(w, 'yes')
    expect(status).not.toBe(0)
    world('check-refused', w)
    world('check-untouched', w)
  })

  it('refuses an occupied worktree and a busy status row', () => {
    const w = world('new', 'occupied')
    const { status } = launch(w, 'yes')
    expect(status).not.toBe(0)
    world('check-refused', w)
    world('check-untouched', w)
  })

  it('launches every task after yes, with the documented argv and prompt', () => {
    const w = world('new', 'ok')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-launched', w)
    world('check-report', w)
  })

  it('carries a writing row and then a free row with the exit code, whatever it is', () => {
    const w = world('new', 'failing')
    const { status } = launch(w, 'yes')
    expect(status).not.toBe(0)
    world('check-rows', w)
  })
})
