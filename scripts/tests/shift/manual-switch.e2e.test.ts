import type { ShiftDeps } from '../../shift/shift.js'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runShift } from '../../shift/shift.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const SHIFT = path.join(REPO_ROOT, 'scripts/shift/shift.ts')
const HEADER = readFileSync(path.join(REPO_ROOT, 'scripts/shift/header.md'), 'utf8')
const RUN_ON_A_TERMINAL = 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)'
const NOT_TAKEN = '[shift] 01.md 1: not taken, not confirmed (--manual)'
const PROMPT = '[shift] take #1 task-1 (cheap/auto)? [y/N]'
const roots: string[] = []

interface World {
  root: string
  shift: string
}

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-manual-world-')))
  roots.push(root)
  const shift = path.join(root, 'shift')
  mkdirSync(shift)
  writeFileSync(path.join(shift, '01.md'), 'card: #1 task-1 [implement/runner/S/cheap/auto] · depends — · blocks —\nbranch: feat/1\ntouches: a.ts\n\ndo a\n')
  return { root, shift }
}

function shiftDeps(world: World, out: string[], confirm: ShiftDeps['confirm'], runs: string[]): ShiftDeps {
  return {
    cwd: world.root,
    claude: 'true',
    header: HEADER,
    handoffDir: path.join(world.root, 'handoff'),
    readJournal: file => existsSync(file) ? readFileSync(file, 'utf8') : '',
    projectsDir: path.join(world.root, 'projects'),
    git: () => '',
    install: () => {},
    gh: () => '[]',
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date('2026-10-06T00:00:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001',
    confirm,
    run: async () => {
      runs.push('run')
      return { kind: 'exited', code: 0, signal: null }
    },
    out: line => out.push(line),
    err: () => {},
  }
}

function realRunner(world: World, command: string, args: string[], answer: string): { stdout: string, stderr: string, status: number | null } {
  const env = { ...process.env, SHIFT_CLAUDE: 'false', CONSTRUCT_HANDOFF_DIR: path.join(world.root, 'handoff'), NO_COLOR: '1' }
  const result = spawnSync(command, [...args, TSX, SHIFT, '--manual', world.shift], { cwd: world.root, env, input: answer, encoding: 'utf8', timeout: 60_000 })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('the --manual switch answers no unless a person on a terminal says y or yes', () => {
  it('a confirm that throws answers no: the card is not taken and no session runs', async () => {
    const world = newWorld()
    const out: string[] = []
    const runs: string[] = []
    const code = await runShift(['--manual', world.shift], shiftDeps(world, out, async () => {
      throw new Error('the terminal went away')
    }, runs))
    expect(out).toContain(NOT_TAKEN)
    expect(runs).toEqual([])
    expect(code).toBe(0)
  })

  it('the real runner with no terminal on stdin asks nothing and takes nothing, even with y piped in', () => {
    const world = newWorld()
    const result = realRunner(world, process.execPath, [], 'y\n')
    expect(result.stderr).not.toContain('[y/N]')
    expect(result.stdout).toContain(NOT_TAKEN)
    expect(result.status).toBe(0)
  }, 60_000)

  it('the real runner on a terminal asks, and an answer of n is not a yes', () => {
    const world = newWorld()
    const result = realRunner(world, 'python3', ['-c', RUN_ON_A_TERMINAL, process.execPath], 'n\n')
    expect(result.stdout).toContain(PROMPT)
    expect(result.stdout).toContain(NOT_TAKEN)
    expect(result.status).toBe(0)
  }, 60_000)
})
