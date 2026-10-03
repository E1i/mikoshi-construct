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

function cardOf(id: string, kind: 'implement' | 'probe' = 'implement'): string {
  return `#${id} task-${id} [${kind}/runner/S/cheap/${kind === 'probe' ? 'none' : 'auto'}] · depends — · blocks —`
}

function taskFile(world: World, file: string, id: string, touches: string, body: string, kind: 'implement' | 'probe' = 'implement'): void {
  writeFileSync(path.join(world.shift, file), `card: ${cardOf(id, kind)}\nbranch: feat/${id}\ntouches: ${touches}\n\n${body}\n`)
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
    install: () => {},
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
    taskFile(world, '01.md', '1', 'scripts/a/**', 'STUB-FAIL here')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'do b')
    const io = captured()
    const code = await runShift([world.shift], shiftDeps(world, io))
    expect(code).toBe(1)
    const tasks = jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task')
    expect(tasks.map(line => [line.task, line.exit])).toEqual([['1', 1], ['2', 0]])
    expect(existsSync(path.join(world.shift, 'report-01.md'))).toBe(false)
    expect(readFileSync(path.join(world.shift, 'report-02.md'), 'utf8')).toContain('result: did mc-2')
  })
})

describe('w2: each task runs in its own tree, on the board, with the runner session', () => {
  it('w2: each stub ran in ../mc-<id> on its branch with -p, and ghosts.jsonl has one start line per task carrying the same session', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'do b')
    expect(await runShift([world.shift], shiftDeps(world, captured()))).toBe(0)
    const board = jsonl(path.join(world.handoff, 'ghosts.jsonl'))
    for (const id of ['1', '2']) {
      const worktree = path.join(world.root, `mc-${id}`)
      expect(stubSaw(world, id, 'cwd')).toBe(worktree)
      expect(stubSaw(world, id, 'flags')).toBe('-p')
      expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(`feat/${id}`)
      const line = board.find(entry => entry.task === id)
      expect(line).toMatchObject({ event: 'path', path: 'cheap', worktree, branch: `feat/${id}`, session: stubSaw(world, id, 'session') })
    }
    expect(stubSaw(world, '1', 'session')).not.toBe(stubSaw(world, '2', 'session'))
  })

  it('w2: the prompt is the header with the task filled in, then the body', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**, docs/a.md', 'do a')
    await runShift([world.shift], shiftDeps(world, captured()))
    const prompt = stubSaw(world, '1', 'prompt')
    expect(prompt).toContain(`Your tree is \`${path.join(world.root, 'mc-1')}\`, already cut on branch \`feat/1\``)
    expect(prompt).toContain('declares: `scripts/a/**`, `docs/a.md`.')
    expect(prompt).toContain('Run no background command, no monitor and no wait for a notification')
    expect(prompt).not.toContain('{{')
    expect(prompt.endsWith('---\n\ndo a')).toBe(true)
  })
})

describe('w3: shift:report builds the table from the shift', () => {
  it('w3: task, exit, duration, PR, the Eddies stop of the task session only, and the result line', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'STUB-FAIL here')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'do b')
    await runShift([world.shift], shiftDeps(world, captured()))
    const eddies = (id: string, session: string): void => {
      const dir = path.join(world.root, `mc-${id}`, '.construct')
      mkdirSync(dir, { recursive: true })
      appendFileSync(path.join(dir, 'eddies.jsonl'), `${JSON.stringify({ event: 'budget-stop', level: 'session-context', spent: 250000, limit: 250000, tool: 'Agent', at: 'x', session_id: session })}\n`)
    }
    eddies('1', stubSaw(world, '1', 'session'))
    eddies('2', 'another-session')
    const io = captured()
    const deps: ReportDeps = {
      cwd: world.repo,
      handoffDir: world.handoff,
      gh: ghOf([], [{ number: 436, headRefName: 'feat/2', headRefOid: 'x', state: 'OPEN', mergedAt: null, mergeCommit: null }]),
      read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
      budget: (worktree): BudgetLine[] => readBudgetLines(worktree),
      out: line => io.out.push(line),
      err: line => io.err.push(line),
    }
    expect(runReport([world.shift], deps)).toBe(0)
    expect(io.out).toEqual([
      expect.stringMatching(/^-{4} 01\.md #1 task-1 \[implement\/runner\/S\/cheap\/auto\] -+$/),
      'CONTRACT | implement · cheap · auto · touches not in shift.jsonl · law none recorded',
      'EXPECT   | expect none — shift.jsonl records no forecast',
      `ACTION   | claude session ${stubSaw(world, '1', 'session')} on feat/1, 2m 02s`,
      'RESULT   | exit 1 · no PR · not closed · eddies stop session-context 250000/250000 · report: no report',
      expect.stringMatching(/^-{4} 02\.md #2 task-2 \[implement\/runner\/S\/cheap\/auto\] -+$/),
      'CONTRACT | implement · cheap · auto · touches not in shift.jsonl · law none recorded',
      'EXPECT   | expect none — shift.jsonl records no forecast',
      `ACTION   | claude session ${stubSaw(world, '2', 'session')} on feat/2, 2m 02s`,
      'RESULT   | exit 0 · PR #436 · not closed · eddies stop — · report: did mc-2',
    ])
  })
})

describe('w8: the shift prints the four fields when it starts a task', () => {
  it('w8: CONTRACT carries the card and the declared touches, EXPECT reads none, ACTION names the branch, RESULT waits for the outcome line', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**, docs/a.md', 'do a')
    const io = captured()
    await runShift([world.shift], shiftDeps(world, io))
    expect(io.out.slice(0, 5)).toEqual([
      expect.stringMatching(/^-{4} shift 01\.md #1 task-1 -+$/),
      'CONTRACT | implement · cheap · auto · touches scripts/a/**, docs/a.md · law none recorded',
      'EXPECT   | expect none — a shift task reads no forecast',
      'ACTION   | task:start feat/1 #1, then a headless claude session in its tree',
      'RESULT   | — running; the outcome line [shift] 01.md 1: … follows',
    ])
    expect(io.out).toContain('[shift] 01.md 1: exit 0')
  })
})

describe('w4: overlapping touches refuse the shift', () => {
  it('w4: every overlapping pair is listed, no tree is cut and no session starts', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/night/**', 'do a')
    taskFile(world, '02.md', '2', 'docs/b.md', 'do b')
    taskFile(world, '04.md', '3', 'scripts/night/run.ts, docs/b.md', 'do c')
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
    taskFile(world, '02.md', '2', 'scripts/board/**, docs/b.md', 'do b')
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
    taskFile(world, '01.md', '1', 'scripts/board/**', 'do a')
    const io = captured()
    expect(await runShift([world.shift, '--check'], shiftDeps(world, io, [{ number: 7, headRefName: 'feat/x', files: [{ path: 'scripts/board' }] }]))).toBe(0)
    expect(io.err).toEqual(['[shift] warning: 01.md × PR #7: scripts/board/**'])
    expect(io.out).toEqual(['[shift] check passed: 01.md'])
    expect(readdirSync(world.stubOut)).toEqual([])
    expect(existsSync(path.join(world.shift, 'shift.jsonl'))).toBe(false)
  })

  it('refuses a directory whose shift.jsonl exists', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    writeFileSync(path.join(world.shift, 'shift.jsonl'), '')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(1)
    expect(io.err[0]).toContain('this shift already ran')
    expect(readdirSync(world.stubOut)).toEqual([])
  })

  it('refuses without SHIFT_CLAUDE and cuts nothing', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    const io = captured()
    expect(await runShift([world.shift], { ...shiftDeps(world, io), claude: undefined })).toBe(1)
    expect(io.err).toEqual(['[shift] SHIFT_CLAUDE is not set; it names the claude command (see --help)'])
    expect(readdirSync(world.root).filter(name => name.startsWith('mc-'))).toEqual([])
  })

  it('records a task whose tree cannot be cut and goes on to the next', async () => {
    const world = newWorld()
    mkdirSync(path.join(world.root, 'mc-1'))
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'do b')
    expect(await runShift([world.shift], shiftDeps(world, captured()))).toBe(1)
    const tasks = jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task')
    expect(tasks[0]).toMatchObject({ task: '1', exit: null, worktree: null })
    expect(String(tasks[0]!.refused)).toContain('already exists')
    expect(tasks[1]).toMatchObject({ task: '2', exit: 0 })
  })
})

describe('w6: a session that exits 0 without writing its report is not a success', () => {
  it('w6: shift.jsonl records report false, the runner prints exit 0, no report and exits 1, and shift:report shows it in the exit column', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'STUB-SILENT here')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'do b')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(1)
    const tasks = jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task')
    expect(tasks.map(line => [line.task, line.exit, line.report])).toEqual([['1', 0, false], ['2', 0, true]])
    expect(io.out).toContain('[shift] 01.md 1: exit 0, no report')
    expect(io.out).toContain('[shift] 02.md 2: exit 0')
    const report = captured()
    runReport([world.shift], { cwd: world.repo, handoffDir: world.handoff, gh: ghOf([]), read: file => existsSync(file) ? readFileSync(file, 'utf8') : null, budget: () => [], out: line => report.out.push(line), err: line => report.err.push(line) })
    expect(report.out[4]).toBe('RESULT   | exit 0, no report · no PR · not closed · eddies stop — · report: no report')
    expect(report.out[9]).toBe('RESULT   | exit 0 · no PR · not closed · eddies stop — · report: did mc-2')
  })
})

describe('w8: shift:report shows whether each task was closed with task:close', () => {
  it('w8: RESULT of a task with a task:close line carrying verification reads closed with the word; one without reads not closed', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'do b')
    taskFile(world, '03.md', '3', 'scripts/c/**', 'do c')
    expect(await runShift([world.shift], shiftDeps(world, captured()))).toBe(0)
    const journal = path.join(world.handoff, 'ghosts.jsonl')
    appendFileSync(journal, `${JSON.stringify({ event: 'path', task: '1', path: 'cheap', pr: 501, verification: 'run', ts: 'x' })}\n`)
    appendFileSync(journal, `${JSON.stringify({ event: 'path', task: '3', path: 'cheap', pr: 503, ts: 'x' })}\n`)
    const report = captured()
    expect(runReport([world.shift], { cwd: world.repo, handoffDir: world.handoff, gh: ghOf([]), read: file => existsSync(file) ? readFileSync(file, 'utf8') : null, budget: () => [], out: line => report.out.push(line), err: line => report.err.push(line) })).toBe(0)
    expect(report.out.filter(row => row.startsWith('RESULT'))).toEqual([
      'RESULT   | exit 0 · no PR · closed run · eddies stop — · report: did mc-1',
      'RESULT   | exit 0 · no PR · not closed · eddies stop — · report: did mc-2',
      'RESULT   | exit 0 · no PR · not closed · eddies stop — · report: did mc-3',
    ])
  })
})

describe('w7: a probe card closes with a report, not a pull request', () => {
  it('w7: a probe with a report and no PR is clean: the runner exits 0 and the PR cell reads —; a probe that writes no report fails', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'probe it', 'probe')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'STUB-SILENT here', 'probe')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(1)
    expect(io.out).toContain('[shift] 01.md 1: exit 0')
    expect(io.out).toContain('[shift] 02.md 2: exit 0, no report')
    const report = captured()
    runReport([world.shift], { cwd: world.repo, handoffDir: world.handoff, gh: ghOf([]), read: file => existsSync(file) ? readFileSync(file, 'utf8') : null, budget: () => [], out: line => report.out.push(line), err: line => report.err.push(line) })
    expect(report.out[4]).toBe('RESULT   | exit 0 · — · not closed · eddies stop — · report: did mc-1')
    expect(report.out[9]).toBe('RESULT   | exit 0, no report · — · not closed · eddies stop — · report: no report')
  })

  it('w7: the runner passes the card to task:start, and the start line carries it', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'probe it', 'probe')
    await runShift([world.shift], shiftDeps(world, captured()))
    const start = jsonl(path.join(world.handoff, 'ghosts.jsonl'))[0]
    expect(start).toMatchObject({ task: '1', card: { id: 1, kind: 'probe', decision: 'none', line: cardOf('1', 'probe') } })
    expect(jsonl(path.join(world.shift, 'shift.jsonl')).find(line => line.event === 'task')).toMatchObject({ card: { id: 1, kind: 'probe' } })
  })

  it('w7: a task file with task: instead of card: refuses the shift and starts nothing', async () => {
    const world = newWorld()
    writeFileSync(path.join(world.shift, '01.md'), 'task: 1\nbranch: feat/1\ntouches: scripts/a/**\n\ndo a\n')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(1)
    expect(io.err).toEqual([`[shift] 01.md: 'task:' is replaced by 'card: <the task's card>'; the id is the card's #<id>`])
    expect(readdirSync(world.stubOut)).toEqual([])
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
