import type { BudgetLine } from '../../board/eddies.js'
import type { ReportDeps } from '../../shift/report.js'
import type { ShiftDeps } from '../../shift/shift.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBudgetLines } from '../../board/eddies.js'
import { runClaude } from '../../shift/claude.js'
import { runReport } from '../../shift/report.js'
import { runShift } from '../../shift/shift.js'

const STUB = path.join(import.meta.dirname, 'fixtures', 'claude-stub.sh')
const HEADER = readFileSync(path.join(import.meta.dirname, '../../shift/header.md'), 'utf8')
const T0 = Date.parse('2026-10-03T01:00:00.000Z')
const TICK_SECONDS = 61

interface World {
  root: string
  repo: string
  handoff: string
  shift: string
  stubOut: string
}

interface Captured {
  out: string[]
  err: string[]
}

interface OpenPrFixture {
  number: number
  headRefName: string
  files: { path: string }[]
}

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-world-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  const shift = path.join(root, 'shift')
  const stubOut = path.join(root, 'stub-out')
  mkdirSync(shift)
  mkdirSync(stubOut)
  return { root, repo, handoff: path.join(root, 'handoff'), shift, stubOut }
}

function taskFile(world: World, file: string, id: string, touches: string, body: string): void {
  writeFileSync(path.join(world.shift, file), `task: ${id}\nbranch: feat/${id}\ntouches: ${touches}\n\n${body}\n`)
}

function ghOf(openPrs: OpenPrFixture[], allPrs: unknown[] = []): (args: string[]) => string {
  return args => JSON.stringify(args.includes('open') ? openPrs : allPrs)
}

function shiftDeps(world: World, captured: Captured, openPrs: OpenPrFixture[] = []): ShiftDeps {
  let ticks = 0
  let uuids = 0
  return {
    cwd: world.repo,
    claude: `STUB_OUT=${world.stubOut} sh ${STUB}`,
    header: HEADER,
    handoffDir: world.handoff,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    gh: ghOf(openPrs),
    listDir: dir => readdirSync(dir),
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(T0 + 1000 * TICK_SECONDS * ticks++),
    uuid: () => `00000000-0000-4000-8000-00000000000${++uuids}`,
    run: runClaude,
    out: line => captured.out.push(line),
    err: line => captured.err.push(line),
  }
}

function captured(): Captured {
  return { out: [], err: [] }
}

function jsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

function stubSaw(world: World, id: string, what: 'cwd' | 'session' | 'flags' | 'prompt'): string {
  return readFileSync(path.join(world.stubOut, `mc-${id}.${what}`), 'utf8').trim()
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('w1: a task that fails does not stop the shift', () => {
  it('w1: task 01 exits 1, task 02 still runs, and shift.jsonl records both', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/a/**', 'STUB-FAIL here')
    taskFile(world, '02.md', 'b', 'scripts/b/**', 'do b')
    const io = captured()
    const code = await runShift([world.shift], shiftDeps(world, io))
    expect(code).toBe(1)
    const tasks = jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task')
    expect(tasks.map(line => [line.task, line.exit])).toEqual([['a', 1], ['b', 0]])
    expect(existsSync(path.join(world.shift, 'report-01.md'))).toBe(false)
    expect(readFileSync(path.join(world.shift, 'report-02.md'), 'utf8')).toContain('result: did mc-b')
  })
})

describe('w2: each task runs in its own tree, on the board, with the runner session', () => {
  it('w2: each stub ran in ../mc-<id> on its branch with -p, and ghosts.jsonl has one start line per task carrying the same session', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/a/**', 'do a')
    taskFile(world, '02.md', 'b', 'scripts/b/**', 'do b')
    expect(await runShift([world.shift], shiftDeps(world, captured()))).toBe(0)
    const board = jsonl(path.join(world.handoff, 'ghosts.jsonl'))
    for (const id of ['a', 'b']) {
      const worktree = path.join(world.root, `mc-${id}`)
      expect(stubSaw(world, id, 'cwd')).toBe(worktree)
      expect(stubSaw(world, id, 'flags')).toBe('-p')
      expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(`feat/${id}`)
      const line = board.find(entry => entry.task === id)
      expect(line).toMatchObject({ event: 'path', path: 'cheap', worktree, branch: `feat/${id}`, session: stubSaw(world, id, 'session') })
    }
    expect(stubSaw(world, 'a', 'session')).not.toBe(stubSaw(world, 'b', 'session'))
  })

  it('w2: the prompt is the header with the task filled in, then the body', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/a/**, docs/a.md', 'do a')
    await runShift([world.shift], shiftDeps(world, captured()))
    const prompt = stubSaw(world, 'a', 'prompt')
    expect(prompt).toContain(`Your tree is \`${path.join(world.root, 'mc-a')}\`, already cut on branch \`feat/a\``)
    expect(prompt).toContain('declares: `scripts/a/**`, `docs/a.md`.')
    expect(prompt).toContain('Run no background command, no monitor and no wait for a notification')
    expect(prompt).not.toContain('{{')
    expect(prompt.endsWith('---\n\ndo a')).toBe(true)
  })
})

describe('w3: shift:report builds the table from the shift', () => {
  it('w3: task, exit, duration, PR, the Eddies stop of the task session only, and the result line', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/a/**', 'STUB-FAIL here')
    taskFile(world, '02.md', 'b', 'scripts/b/**', 'do b')
    await runShift([world.shift], shiftDeps(world, captured()))
    const eddies = (id: string, session: string): void => {
      const dir = path.join(world.root, `mc-${id}`, '.construct')
      mkdirSync(dir, { recursive: true })
      appendFileSync(path.join(dir, 'eddies.jsonl'), `${JSON.stringify({ event: 'budget-stop', level: 'session-context', spent: 250000, limit: 250000, tool: 'Agent', at: 'x', session_id: session })}\n`)
    }
    eddies('a', stubSaw(world, 'a', 'session'))
    eddies('b', 'another-session')
    const io = captured()
    const deps: ReportDeps = {
      cwd: world.repo,
      gh: ghOf([], [{ number: 436, headRefName: 'feat/b', headRefOid: 'x', state: 'OPEN', mergedAt: null, mergeCommit: null }]),
      read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
      budget: (worktree): BudgetLine[] => readBudgetLines(worktree),
      out: line => io.out.push(line),
      err: line => io.err.push(line),
    }
    expect(runReport([world.shift], deps)).toBe(0)
    expect(io.out).toEqual([
      'task     exit  duration  PR       eddies stop                    report',
      '01.md a  1     2m 02s    no PR    session-context 250000/250000  no report',
      '02.md b  0     2m 02s    PR #436  —                              did mc-b',
    ])
  })
})

describe('w4: overlapping touches refuse the shift', () => {
  it('w4: every overlapping pair is listed, no tree is cut and no session starts', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/night/**', 'do a')
    taskFile(world, '02.md', 'b', 'docs/b.md', 'do b')
    taskFile(world, '04.md', 'c', 'scripts/night/run.ts, docs/b.md', 'do c')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(1)
    expect(io.err).toEqual([
      '[shift] tasks of one shift declare overlapping touches; nothing started',
      '[shift] 01.md × 04.md: scripts/night/** ⊃ scripts/night/run.ts',
      '[shift] 02.md × 04.md: docs/b.md = docs/b.md',
    ])
    expect(readdirSync(world.root).filter(name => name.startsWith('mc-'))).toEqual([])
    expect(readdirSync(world.stubOut)).toEqual([])
    expect(existsSync(path.join(world.shift, 'shift.jsonl'))).toBe(false)
  })
})

describe('w5: touches that meet an open pull request warn, and the shift starts', () => {
  it('w5: prints NN.md × PR #N: <entry> and runs the task', async () => {
    const world = newWorld()
    taskFile(world, '02.md', 'b', 'scripts/board/**, docs/b.md', 'do b')
    const io = captured()
    const code = await runShift([world.shift], shiftDeps(world, io, [{ number: 436, headRefName: 'feat/x', files: [{ path: 'scripts/board/run.ts' }] }]))
    expect(code).toBe(0)
    expect(io.err).toEqual(['[shift] warning: 02.md × PR #436: scripts/board/**'])
    expect(existsSync(path.join(world.shift, 'report-02.md'))).toBe(true)
  })
})

describe('--check and a shift that already ran', () => {
  it('--check reports the tasks and the open-PR warnings and starts nothing', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/board/**', 'do a')
    const io = captured()
    expect(await runShift([world.shift, '--check'], shiftDeps(world, io, [{ number: 7, headRefName: 'feat/x', files: [{ path: 'scripts/board' }] }]))).toBe(0)
    expect(io.err).toEqual(['[shift] warning: 01.md × PR #7: scripts/board/**'])
    expect(io.out).toEqual(['[shift] check passed: 01.md'])
    expect(readdirSync(world.stubOut)).toEqual([])
    expect(existsSync(path.join(world.shift, 'shift.jsonl'))).toBe(false)
  })

  it('refuses a directory whose shift.jsonl exists', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/a/**', 'do a')
    writeFileSync(path.join(world.shift, 'shift.jsonl'), '')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(1)
    expect(io.err[0]).toContain('this shift already ran')
    expect(readdirSync(world.stubOut)).toEqual([])
  })

  it('refuses without SHIFT_CLAUDE and cuts nothing', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/a/**', 'do a')
    const io = captured()
    expect(await runShift([world.shift], { ...shiftDeps(world, io), claude: undefined })).toBe(1)
    expect(io.err).toEqual(['[shift] SHIFT_CLAUDE is not set; it names the claude command (see --help)'])
    expect(readdirSync(world.root).filter(name => name.startsWith('mc-'))).toEqual([])
  })

  it('records a task whose tree cannot be cut and goes on to the next', async () => {
    const world = newWorld()
    mkdirSync(path.join(world.root, 'mc-a'))
    taskFile(world, '01.md', 'a', 'scripts/a/**', 'do a')
    taskFile(world, '02.md', 'b', 'scripts/b/**', 'do b')
    expect(await runShift([world.shift], shiftDeps(world, captured()))).toBe(1)
    const tasks = jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task')
    expect(tasks[0]).toMatchObject({ task: 'a', exit: null, worktree: null })
    expect(String(tasks[0]!.refused)).toContain('already exists')
    expect(tasks[1]).toMatchObject({ task: 'b', exit: 0 })
  })
})

describe('w6: a session that exits 0 without writing its report is not a success', () => {
  it('w6: shift.jsonl records report false, the runner prints exit 0, no report and exits 1, and shift:report shows it in the exit column', async () => {
    const world = newWorld()
    taskFile(world, '01.md', 'a', 'scripts/a/**', 'STUB-SILENT here')
    taskFile(world, '02.md', 'b', 'scripts/b/**', 'do b')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(1)
    const tasks = jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task')
    expect(tasks.map(line => [line.task, line.exit, line.report])).toEqual([['a', 0, false], ['b', 0, true]])
    expect(io.out).toContain('[shift] 01.md a: exit 0, no report')
    expect(io.out).toContain('[shift] 02.md b: exit 0')
    const report = captured()
    runReport([world.shift], { cwd: world.repo, gh: ghOf([]), read: file => existsSync(file) ? readFileSync(file, 'utf8') : null, budget: () => [], out: line => report.out.push(line), err: line => report.err.push(line) })
    expect(report.out[1]).toMatch(/^01\.md a {2}0, no report {2}.* no report$/)
    expect(report.out[2]).toMatch(/^02\.md b {2}0 {13}.* did mc-b$/)
  })
})

describe('--help: caffeinate wraps the runner', () => {
  it('shows caffeinate -dis around pnpm shift and an SHIFT_CLAUDE example without caffeinate', async () => {
    const io = captured()
    expect(await runShift(['--help'], shiftDeps(newWorld(), io))).toBe(0)
    const help = io.out.join('\n').split('\n')
    expect(help).toContain('  caffeinate -dis pnpm shift <dir>')
    expect(help.filter(line => line.includes('SHIFT_CLAUDE=') && line.includes('caffeinate'))).toEqual([])
  })
})
