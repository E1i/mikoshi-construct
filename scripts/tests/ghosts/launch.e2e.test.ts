import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')

const createdWorlds: string[] = []

function world(...args: string[]): string {
  const result = spawnSync('bash', [WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  const output = result.stdout.trim()
  if (args[0] === 'new')
    createdWorlds.push(output)
  return output
}

afterEach(() => {
  while (createdWorlds.length > 0)
    world('clean', createdWorlds.pop()!)
})

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

function launchFrom(worldDir: string, cwd: string, answer: string): { status: number | null, output: string } {
  const bin = path.join(worldDir, 'bin')
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), LAUNCH, '--tasks', path.join(worldDir, 'tasks.json')], {
    cwd,
    input: `${answer}\n`,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function launchSealed(worldDir: string, answer: string): { status: number | null } {
  const sealedPath = readFileSync(path.join(worldDir, '.world', 'sealed-path'), 'utf8').trim()
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), LAUNCH, '--tasks', path.join(worldDir, 'tasks.json')], {
    input: `${answer}\n`,
    encoding: 'utf8',
    env: { ...process.env, PATH: sealedPath },
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

  it('refuses a brief with two /implement lines before any listing, naming both line numbers', () => {
    const w = world('new', 'two-implement')
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
    world('check-ladder', w)
    world('check-install', w)
    world('check-journal', w)
    world('check-summary', w)
  })

  it('still launches a brief that gained trailing newlines after approval, with the canonical text as the prompt', () => {
    const w = world('new', 'trailing-newline')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-launched', w)
  })

  it('reads an all-digit id from its #<id> matrix row, never the bare <id> row', () => {
    const w = world('new', 'numeric-id')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-launched', w)
    world('check-ladder', w)
    world('check-journal', w)
  })

  it('carries a writing row and then a free row with the exit code, whatever it is', () => {
    const w = world('new', 'failing')
    const { status } = launch(w, 'yes')
    expect(status).not.toBe(0)
    world('check-rows', w)
    world('check-ladder', w)
    world('check-summary', w)
  })

  it('reads no new ladder line as "no ladder run", even though an older line exists and the stream reports success', () => {
    const w = world('new', 'no-ladder')
    const { status } = launch(w, 'yes')
    expect(status).not.toBe(0)
    world('check-ladder', w)
    world('check-summary', w)
  })

  it('gives null result fields, marked missing, without failing the task', () => {
    const w = world('new', 'no-result')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-ladder', w)
    world('check-journal', w)
  })

  it('reads a matrix row into the journal for a task the matrix names', () => {
    const w = world('new', 'with-matrix')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-journal', w)
    world('check-install', w)
  })

  it('refuses a relative out before any worktree or row is touched, naming the field', () => {
    const w = world('new', 'ok')
    const tasksPath = path.join(w, 'tasks.json')
    writeFileSync(tasksPath, JSON.stringify({ ...JSON.parse(readFileSync(tasksPath, 'utf8')) as object, out: 'handoff' }))
    const { status, output } = launchFrom(w, w, 'yes')
    expect(status).toBe(1)
    expect(output).toContain('tasks file field out: expected an absolute path')
    expect(output).not.toContain('DECISION:')
    world('check-untouched', w)
  })

  it.each([
    { name: 'missing', spoil: (file: string) => rmSync(file) },
    { name: 'unparsable', spoil: (file: string) => writeFileSync(file, '{ not json') },
  ])('refuses a $name matrix file before any worktree or row is touched, naming its path', ({ spoil }) => {
    const w = world('new', 'with-matrix')
    const matrixPath = path.join(w, 'matrix.json')
    spoil(matrixPath)
    const { status, output } = launchFrom(w, REPO_ROOT, 'yes')
    expect(status).toBe(1)
    expect(output).toContain(`matrix ${matrixPath}:`)
    expect(output).not.toContain('DECISION:')
    world('check-untouched', w)
  })

  it('appends the journal after the lines it already held', () => {
    const w = world('new', 'journal-exists')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-journal', w)
  })

  it('starts no session, frees the row and exits 1 when the install fails', () => {
    const w = world('new', 'install-fails')
    const { status } = launch(w, 'yes')
    expect(status).not.toBe(0)
    world('check-install', w)
    world('check-ladder', w)
    world('check-journal', w)
    world('check-summary', w)
  })

  it('frees every row and exits 1 instead of crashing when the install cannot be spawned', () => {
    const w = world('new', 'install-unspawnable')
    const { status } = launchSealed(w, 'yes')
    expect(status).not.toBe(0)
    world('check-install', w)
    world('check-ladder', w)
    world('check-journal', w)
    world('check-summary', w)
  })

  it('frees the row and exits 1 instead of crashing when the session cannot be spawned, while the other task runs to ladder done', () => {
    const w = world('new', 'session-unspawnable')
    const { status } = launchSealed(w, 'yes')
    expect(status).not.toBe(0)
    world('check-install', w)
    world('check-ladder', w)
    world('check-journal', w)
    world('check-summary', w)
  })

  it('starts a task from its sketch: HEAD at origin/main, the sketch staged, the journal naming its sha', () => {
    const w = world('new', 'sketch')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-decision', w)
    world('check-launched', w)
    world('check-sketch', w)
    world('check-journal', w)
  })

  it('journals the expect: forecast of g2 beside the ladder\'s actual tokens and minutes, and builds its args from a text whose line 3 is expect:', () => {
    const w = world('new', 'expect')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-decision', w)
    world('check-launched', w)
    world('check-args', w)
    world('check-journal', w)
  })

  it('gives each session the args file built from the agreed text, and the session\'s ledger row names both of its hashes', () => {
    const w = world('new', 'ok')
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-args', w)
  })

  it.each([
    { title: 'builds the args of g2 from a text other than the approved one', kind: 'args-elsewhere' },
    { title: 'rewrites the args file of g2 after the row named its bytes', kind: 'args-rewritten' },
    { title: 'writes the ledger row of g2 without the two hashes', kind: 'row-without-hashes' },
  ])('$title, while g1 stays tied', ({ kind }) => {
    const w = world('new', kind)
    const { status } = launch(w, 'yes')
    expect(status).toBe(0)
    world('check-args', w)
    world('check-journal', w)
  })

  it.each([
    { title: 'refuses a brief with no Sketch: line before any listing', kind: 'sketch-no-line' },
    { title: 'refuses a sketch whose branch does not exist', kind: 'sketch-no-branch' },
    { title: 'refuses a sketch whose branch tip is not the approved sha', kind: 'sketch-moved' },
    { title: 'refuses a sketch that does not contain origin/main', kind: 'sketch-stale' },
    { title: 'refuses a malformed expect: line, quoting it', kind: 'expect-malformed' },
    { title: 'refuses an expect: line below line 3, naming its line number', kind: 'expect-misplaced' },
  ])('$title', ({ kind }) => {
    const w = world('new', kind)
    const { status } = launch(w, 'yes')
    expect(status).toBe(1)
    world('check-refused', w)
    world('check-untouched', w)
  })
})
