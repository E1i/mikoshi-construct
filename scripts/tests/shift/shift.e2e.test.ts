import type { BudgetLine } from '../../board/eddies.js'
import type { ReportDeps } from '../../shift/report.js'
import type { ShiftDeps } from '../../shift/shift.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBudgetLines } from '../../board/eddies.js'
import { entryOf } from '../../ghosts/entry.js'
import { runClaude } from '../../shift/claude.js'
import { CONTINUE_PROMPT, MAX_RESTARTS } from '../../shift/continuation.js'
import { runReport } from '../../shift/report.js'
import { holdThroughHangup, runShift } from '../../shift/shift.js'
import { captured as capturedIo, depsOf as chainDepsOf, eventsOf, fakeGh, newWorld as newChainWorld, cardLine as parkedCardLine } from './fixtures/autopilot-world.js'
import './fixtures/stub-handoff.js'

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

function taskFile(world: World, file: string, id: string, touches: string, body: string, kind: 'implement' | 'probe' = 'implement', extraHeader = ''): void {
  writeFileSync(path.join(world.shift, file), `card: ${cardOf(id, kind)}\nbranch: feat/${id}\ntouches: ${touches}\n${extraHeader}\n${body}\n`)
}

function continuingTask(world: World, file: string, id: string, body: string, mode: 'auto' | 'stop' = 'auto'): void {
  taskFile(world, file, id, `scripts/${id}/**`, body, 'implement', `continue: ${mode}\n`)
}

function ghOf(openPrs: OpenPrFixture[], allPrs: unknown[] = []): (args: string[]) => string {
  return args => JSON.stringify(args.includes('open') ? openPrs : allPrs)
}

function parkedCardLines(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.md')).flatMap(file => /^card: (.+)$/m.exec(readFileSync(path.join(dir, file), 'utf8'))?.[1] ?? []) : []
}

function everyCardOfTheWorldTakenThroughIntake(world: World): (file: string) => string | null {
  return (file) => {
    const intake = [world.shift, path.join(world.root, 'parking')].flatMap(parkedCardLines).map(line => `${JSON.stringify({ event: 'intake', task: /^#(\d+)/.exec(line)![1], card: line, confirmation: 'none', corrections: [], ts: '2026-10-03T00:00:00.000Z' })}\n`)
    return (existsSync(file) ? readFileSync(file, 'utf8') : '') + intake.join('')
  }
}

function shiftDeps(world: World, captured: Captured, openPrs: OpenPrFixture[] = []): ShiftDeps {
  let ticks = 0
  let uuids = 0
  return {
    cwd: world.repo,
    claude: `STUB_OUT=${world.stubOut} CONSTRUCT_HANDOFF_DIR=${world.handoff} sh ${STUB}`,
    header: HEADER,
    handoffDir: world.handoff,
    readJournal: everyCardOfTheWorldTakenThroughIntake(world),
    projectsDir: path.join(world.root, 'projects'),
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

function pastShift(world: World, size: string, count: number, seconds: (index: number) => number = index => 60 * (index + 1)): void {
  const lines = Array.from({ length: count }, (_, index) => {
    const worktree = path.join(world.root, `mc-past-${size}-${index}`)
    const session = `past-${size}-${index}`
    const sessionFile = path.join(world.root, 'projects', worktree.replace(/[/.]/g, '-'), `${session}.jsonl`)
    mkdirSync(path.dirname(sessionFile), { recursive: true })
    writeFileSync(sessionFile, `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', usage: { input_tokens: 1000 * (index + 1), output_tokens: 0 } } })}\n`)
    const card = { id: 900 + index, name: `past-${index}`, kind: 'implement', milestone: 'runner', size, contour: 'cheap', decision: 'auto', depends: [], blocks: [], line: '' }
    return JSON.stringify({ event: 'task', file: '01.md', number: '01', task: String(900 + index), card, branch: `past/${index}`, session, started: '2026-10-01T00:00:00.000Z', worktree, ended: new Date(Date.parse('2026-10-01T00:00:00.000Z') + seconds(index) * 1000).toISOString(), exit: 0, signal: null, report: true, continuations: [] })
  })
  mkdirSync(path.join(world.root, `past-${size}`))
  writeFileSync(path.join(world.root, `past-${size}`, 'shift.jsonl'), `${lines.join('\n')}\n`)
}

function captured(): Captured {
  return { out: [], err: [] }
}

function jsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

function stubRuns(world: World, id: string): number {
  const file = path.join(world.stubOut, `mc-${id}.runs`)
  return existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : 0
}

function reportDeps(world: World, io: Captured): ReportDeps {
  return { cwd: world.repo, handoffDir: world.handoff, gh: ghOf([]), read: file => existsSync(file) ? readFileSync(file, 'utf8') : null, budget: worktree => readBudgetLines(worktree), out: line => io.out.push(line), err: line => io.err.push(line) }
}

function stubSaw(world: World, id: string, what: 'cwd' | 'session' | 'flags' | 'prompt' | `${'session' | 'prompt'}.${number}`): string {
  return readFileSync(path.join(world.stubOut, `mc-${id}.${what}`), 'utf8').trim()
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
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

  it('the shift session sees its card in CONSTRUCT_CARD', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '7', 'scripts/a/**', 'do a')
    const deps = shiftDeps(world, captured())
    const seen = path.join(world.stubOut, 'card')
    const recordsCard = path.join(world.stubOut, 'records-card')
    writeFileSync(recordsCard, `#!/bin/sh\nprintf '%s' "$CONSTRUCT_CARD" >${seen}\nexec env "$@"\n`, { mode: 0o755 })
    expect(await runShift([world.shift], { ...deps, claude: `${recordsCard} ${deps.claude}` })).toBe(0)
    expect(readFileSync(seen, 'utf8')).toBe('7')
  })

  it('a card the shift starts has the shift directory on its start line', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    await runShift([world.shift], shiftDeps(world, captured()))
    expect(jsonl(path.join(world.handoff, 'ghosts.jsonl')).find(entry => entry.event === 'path' && entry.task === '1')).toMatchObject({ shift: world.shift })
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
    const entryFor = (task: string): NonNullable<ReturnType<typeof entryOf>> => entryOf(readFileSync(path.join(world.handoff, 'ghosts.jsonl'), 'utf8'), task)!
    expect(runReport([world.shift], deps)).toBe(0)
    expect(io.out).toEqual([
      expect.stringMatching(/^-{4} 01\.md #1 task-1 \[implement\/runner\/S\/cheap\/auto\] -+$/),
      `CONTRACT | ${entryFor('1').CONTRACT}`,
      `EXPECT   | ${entryFor('1').EXPECT}`,
      `ACTION   | claude session ${stubSaw(world, '1', 'session')} on feat/1, 2m 02s`,
      'RESULT   | exit 1 · no PR · not closed · restarts 0/3, last exit ended on its own · eddies stop session-context 250000/250000 · report: no report',
      expect.stringMatching(/^-{4} 02\.md #2 task-2 \[implement\/runner\/S\/cheap\/auto\] -+$/),
      `CONTRACT | ${entryFor('2').CONTRACT}`,
      `EXPECT   | ${entryFor('2').EXPECT}`,
      `ACTION   | claude session ${stubSaw(world, '2', 'session')} on feat/2, 2m 02s`,
      'RESULT   | exit 0 · PR #436 · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: did mc-2',
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
      'CONTRACT | implement · cheap · auto · touches scripts/a/**, docs/a.md · law not recorded in the task file',
      'EXPECT   | expect none — n=0 for implement/S',
      'ACTION   | task:start feat/1 #1, then a headless claude session in its tree',
      'RESULT   | — running; the outcome line [shift] 01.md 1: … follows',
    ])
    expect(io.out).toContain('[shift] 01.md 1: exit 0')
  })

  it('w8: EXPECT carries the median tokens and minutes of the class once the shifts beside it hold five finished tasks of it', async () => {
    const world = newWorld()
    pastShift(world, 'S', 5)
    pastShift(world, 'M', 9)
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    const io = captured()
    await runShift([world.shift], shiftDeps(world, io))
    expect(io.out[2]).toBe('EXPECT   | expect tokens ≈ 3k (input, cache writes and output; cache reads left out), minutes ≈ 3 — class implement/S, n=5, median')
  })

  it('w8: below five finished tasks of the class EXPECT reads none with n and the class', async () => {
    const world = newWorld()
    pastShift(world, 'S', 4)
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    const io = captured()
    await runShift([world.shift], shiftDeps(world, io))
    expect(io.out[2]).toBe('EXPECT   | expect none — n=4 for implement/S')
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

function parkedCard(dir: string, id: string, header: string, touches = `scripts/${id}/**`): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${id}.md`), `card: ${cardOf(id)}\nbranch: feat/${id}\ntouches: ${touches}\n${header}\n\ndo ${id}\n`)
}

describe('the shift prints a forecast table before it starts', () => {
  it('the shift forecast table on a three-card parking with one card without journal data', async () => {
    const world = newWorld()
    pastShift(world, 'S', 5)
    const parking = path.join(world.root, 'parking')
    parkedCard(parking, '30', 'who: shift')
    parkedCard(parking, '40', 'who: shift')
    mkdirSync(parking, { recursive: true })
    writeFileSync(path.join(parking, '50.md'), `card: ${cardOf('50', 'probe')}\nbranch: feat/50\ntouches: scripts/50/**\nwho: shift\n\ndo 50\n`)
    parkedCard(parking, '20', 'who: window')
    const io = captured()
    await runShift([world.shift, '--parking', parking], shiftDeps(world, io))
    expect(io.out.slice(2, 7)).toEqual([
      '[shift] CARD         CONTOUR  TOKENS median · p25–p75  MINUTES median · p25–p75',
      '[shift] #30 task-30  cheap    ≈ 3k · 2k–4k             ≈ 3 · 2–4',
      '[shift] #40 task-40  cheap    ≈ 3k · 2k–4k             ≈ 3 · 2–4',
      '[shift] #50 task-50  cheap    — n=0                    — n=0',
      '[shift] total: tokens ≈ 6k, minutes ≈ 6 · takes 3 · left: 1 who window · incomplete: no journal data for #50',
    ])
  })

  it('the shift forecast table rounds fractional minutes to tenths', async () => {
    const world = newWorld()
    const durations = [50, 100, 130, 200, 250]
    pastShift(world, 'S', durations.length, index => durations[index]!)
    const parking = path.join(world.root, 'parking')
    parkedCard(parking, '30', 'who: shift')
    parkedCard(parking, '40', 'who: shift')
    const io = captured()
    await runShift([world.shift, '--parking', parking], shiftDeps(world, io))
    expect(io.out.slice(2, 6)).toEqual([
      '[shift] CARD         CONTOUR  TOKENS median · p25–p75  MINUTES median · p25–p75',
      '[shift] #30 task-30  cheap    ≈ 3k · 2k–4k             ≈ 2.2 · 1.7–3.3',
      '[shift] #40 task-40  cheap    ≈ 3k · 2k–4k             ≈ 2.2 · 1.7–3.3',
      '[shift] total: tokens ≈ 6k, minutes ≈ 4.3 · takes 2 · left: none',
    ])
  })

  it('a forecast total over cards none of which has journal data sums nothing and names every card', async () => {
    const world = newWorld()
    const parking = path.join(world.root, 'parking')
    parkedCard(parking, '30', 'who: shift')
    const io = captured()
    await runShift([world.shift, '--parking', parking], shiftDeps(world, io))
    expect(io.out.slice(2, 5)).toEqual([
      '[shift] CARD         CONTOUR  TOKENS median · p25–p75  MINUTES median · p25–p75',
      '[shift] #30 task-30  cheap    — n=0                    — n=0',
      '[shift] total: tokens —, minutes — · takes 1 · left: none · incomplete: no journal data for #30',
    ])
  })
})

describe('w9: with --parking the shift takes the cards whose who is shift', () => {
  it('w9: runs only the cards for the shift, p0 first, prints what it took and left, and records the choice in the journal', async () => {
    const world = newWorld()
    const parking = path.join(world.root, 'parking')
    parkedCard(parking, '30', 'who: shift')
    parkedCard(parking, '40', 'who: shift\npriority: p0')
    parkedCard(parking, '20', 'who: window')
    parkedCard(parking, '50', 'who: shift')
    mkdirSync(world.handoff, { recursive: true })
    writeFileSync(path.join(world.handoff, 'ghosts.jsonl'), `${JSON.stringify({ event: 'path', task: '50', path: 'cheap', pr: 1, verification: 'run' })}\n`)
    const io = captured()
    expect(await runShift([world.shift, '--parking', parking], shiftDeps(world, io))).toBe(0)
    expect(io.out.slice(0, 2)).toEqual(['[shift] parking: takes #40, #30', '[shift] parking: left: 1 who window · 1 closed'])
    expect(readFileSync(path.join(world.shift, 'queue.txt'), 'utf8')).toBe('leaves #20 (who window)\nleaves #50 (closed)\n')
    const lines = jsonl(path.join(world.shift, 'shift.jsonl'))
    expect(lines[0]).toMatchObject({ event: 'start', tasks: ['40.md', '30.md'], parking, left: [{ id: '20', reason: 'who window' }, { id: '50', reason: 'closed' }] })
    expect(lines.filter(line => line.event === 'task').map(line => [line.task, line.exit])).toEqual([['40', 0], ['30', 0]])
    expect([stubRuns(world, '20'), stubRuns(world, '50')]).toEqual([0, 0])
    expect(readFileSync(path.join(world.shift, 'report-40.md'), 'utf8')).toContain('result: did mc-40')
  })

  it('w9: a parking with no card for the shift refuses and cuts nothing', async () => {
    const world = newWorld()
    const parking = path.join(world.root, 'parking')
    parkedCard(parking, '20', 'who: window')
    const io = captured()
    expect(await runShift([world.shift, '--parking', parking], shiftDeps(world, io))).toBe(1)
    expect(io.err).toEqual([`[shift] no card in ${parking} is for the shift now`])
    expect(readdirSync(world.stubOut)).toEqual([])
  })

  it('w9: --parking ignores the NN.md files in the shift directory, and --check prints the choice and starts nothing', async () => {
    const world = newWorld()
    const parking = path.join(world.root, 'parking')
    taskFile(world, '01.md', '1', 'scripts/a/**', 'do a')
    parkedCard(parking, '30', 'who: shift')
    const io = captured()
    expect(await runShift([world.shift, '--parking', parking, '--check'], shiftDeps(world, io))).toBe(0)
    expect(io.out).toEqual(['[shift] parking: takes #30', '[shift] parking: left: none', '[shift] check passed: 30.md'])
    expect(readdirSync(world.stubOut)).toEqual([])
  })

  it('w9: a parking of 30 cards prints the take and one count line before the first task, and queue.txt holds the list the count sums', async () => {
    const world = newWorld()
    const parking = path.join(world.root, 'parking')
    const closed = Array.from({ length: 12 }, (_, index) => String(100 + index))
    parkedCard(parking, '1', 'who: shift')
    for (const id of closed)
      parkedCard(parking, id, 'who: shift')
    for (let index = 0; index < 10; index++)
      parkedCard(parking, String(200 + index), 'who: window')
    for (let index = 0; index < 5; index++)
      writeFileSync(path.join(parking, `${300 + index}.md`), `card: #${300 + index} task-${300 + index} [implement/runner/S/cheap/auto] · depends #999 · blocks —\nbranch: feat/${300 + index}\ntouches: scripts/${300 + index}/**\nwho: shift\n\ndo it\n`)
    parkedCard(parking, '400', 'who: shift', 'scripts/1/**')
    parkedCard(parking, '401', 'who: shift', 'scripts/1/x.ts')
    mkdirSync(world.handoff, { recursive: true })
    writeFileSync(path.join(world.handoff, 'ghosts.jsonl'), closed.map(id => `${JSON.stringify({ event: 'path', task: id, path: 'cheap', pr: 1, verification: 'run' })}\n`).join(''))
    expect(readdirSync(parking)).toHaveLength(30)

    const checked = captured()
    expect(await runShift([world.shift, '--parking', parking, '--check'], shiftDeps(world, checked))).toBe(0)
    const io = captured()
    expect(await runShift([world.shift, '--parking', parking], shiftDeps(world, io))).toBe(0)

    const summary = '[shift] parking: left: 12 closed · 10 who window · 5 depends · 2 conflicts'
    expect(io.out.slice(0, 2)).toEqual(['[shift] parking: takes #1', summary])
    expect(io.out.findIndex(line => line.includes('CONTRACT'))).toBeLessThanOrEqual(10)
    expect(io.out.some(line => line.includes('(closed)'))).toBe(false)
    expect(checked.out).toEqual(['[shift] parking: takes #1', summary, '[shift] hint: depends are met by merge lines; run pnpm task:merged to record merged pull requests', '[shift] check passed: 1.md'])

    const queue = readFileSync(path.join(world.shift, 'queue.txt'), 'utf8').trimEnd().split('\n')
    expect(queue).toHaveLength(29)
    const counted = (pattern: RegExp): number => queue.filter(line => pattern.test(line)).length
    expect([counted(/\(closed\)$/), counted(/\(who window\)$/), counted(/\(depends /), counted(/\(conflicts with #1\)$/)]).toEqual([12, 10, 5, 2])
    const start = jsonl(path.join(world.shift, 'shift.jsonl'))[0]!
    expect(start.left).toEqual(queue.map(line => ({ id: /#(\d+)/.exec(line)![1], reason: /\((.+)\)$/.exec(line)![1] })))
  })

  it('w9: --queue prints every card left but the closed ones', async () => {
    const world = newWorld()
    const parking = path.join(world.root, 'parking')
    parkedCard(parking, '30', 'who: shift')
    parkedCard(parking, '20', 'who: window')
    parkedCard(parking, '50', 'who: shift')
    mkdirSync(world.handoff, { recursive: true })
    writeFileSync(path.join(world.handoff, 'ghosts.jsonl'), `${JSON.stringify({ event: 'path', task: '50', path: 'cheap', pr: 1, verification: 'run' })}\n`)
    const io = captured()
    expect(await runShift([world.shift, '--parking', parking, '--check', '--queue'], shiftDeps(world, io))).toBe(0)
    expect(io.out).toEqual(['[shift] parking: takes #30', '[shift] parking: left: 1 who window · 1 closed', '[shift] parking: leaves #20 (who window)', '[shift] check passed: 30.md'])
  })

  it('w9: --parking without a directory refuses with the usage line', async () => {
    const world = newWorld()
    const io = captured()
    expect(await runShift([world.shift, '--parking'], shiftDeps(world, io))).toBe(1)
    expect(io.err).toEqual(['[shift] usage: pnpm shift <dir> [--parking <parking>] [--check] [--queue]'])
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
    expect(report.out[4]).toBe('RESULT   | exit 0, no report · no PR · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: no report')
    expect(report.out[9]).toBe('RESULT   | exit 0 · no PR · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: did mc-2')
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
      'RESULT   | exit 0 · no PR · closed run · restarts 0/3, last exit ended on its own · eddies stop — · report: did mc-1',
      'RESULT   | exit 0 · no PR · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: did mc-2',
      'RESULT   | exit 0 · no PR · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: did mc-3',
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
    expect(report.out[4]).toBe('RESULT   | exit 0 · — · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: did mc-1')
    expect(report.out[9]).toBe('RESULT   | exit 0, no report · — · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: no report')
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

describe('w9: continue: auto restarts a session that left on an Eddies warn', () => {
  it('w9: the session warned and exited, the task is open, so a new headless session runs in the same tree with the header and the continuation prompt', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-WARN here')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(0)
    expect(stubRuns(world, '1')).toBe(2)
    expect(stubSaw(world, '1', 'session.2')).not.toBe(stubSaw(world, '1', 'session.1'))
    const second = stubSaw(world, '1', 'prompt.2')
    expect(second.startsWith('# Shift task 1')).toBe(true)
    expect(second).toContain(`Your tree is \`${path.join(world.root, 'mc-1')}\``)
    expect(second).toContain(`${CONTINUE_PROMPT}: the shift report \`${path.join(world.shift, 'report-01.md')}\``)
    expect(second).not.toContain('STUB-WARN')
    const line = jsonl(path.join(world.shift, 'shift.jsonl')).find(entry => entry.event === 'task')
    expect(line).toMatchObject({ session: stubSaw(world, '1', 'session.1'), continuations: [stubSaw(world, '1', 'session.2')], lastExit: 'ended', exit: 0, report: true })
    expect(io.out).toContain(`[shift] 01.md 1: eddies warn, restart 1/${MAX_RESTARTS} in ${path.join(world.root, 'mc-1')}`)
    expect(io.out).toContain('[shift] 01.md 1: exit 0, 1 restart')
  })

  it.each([
    ['continue: stop', 'STUB-WARN here', 'stop', 'eddies-warn'],
    ['an Eddies stop', 'STUB-STOP here', 'auto', 'eddies-stop'],
    ['a refusal of the eddies guard', 'STUB-REFUSED here', 'auto', 'guard-refusal'],
    ['a question to the owner', 'STUB-QUESTION here', 'auto', 'owner-question'],
    ['a task closed with task:close', 'STUB-CLOSE here', 'auto', 'closed'],
  ] as const)('w9: no restart after %s', async (_, body, mode, reason) => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', body, mode)
    await runShift([world.shift], shiftDeps(world, captured()))
    expect(stubRuns(world, '1')).toBe(1)
    expect(jsonl(path.join(world.shift, 'shift.jsonl')).find(entry => entry.event === 'task')).toMatchObject({ continuations: [], lastExit: reason })
  })

  it('w9: a task file without continue: never restarts', async () => {
    const world = newWorld()
    taskFile(world, '01.md', '1', 'scripts/a/**', 'STUB-WARN here')
    await runShift([world.shift], shiftDeps(world, captured()))
    expect(stubRuns(world, '1')).toBe(1)
  })

  it('w9: a session that warns every time is restarted at most MAX_RESTARTS times', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-WARN-ALWAYS here')
    const io = captured()
    await runShift([world.shift], shiftDeps(world, io))
    expect(MAX_RESTARTS).toBe(3)
    expect(stubRuns(world, '1')).toBe(1 + MAX_RESTARTS)
    const line = jsonl(path.join(world.shift, 'shift.jsonl')).find(entry => entry.event === 'task')!
    expect(line).toMatchObject({ lastExit: 'eddies-warn' })
    expect(line.continuations).toHaveLength(MAX_RESTARTS)
    expect(existsSync(path.join(world.shift, 'log-01.3.txt'))).toBe(true)
  })
})

describe('w12: continue: auto restarts a session that stopped at a boundary its report names', () => {
  it('w12: the session left a boundary line and exited 0, so a new headless session runs in the same tree with the header and the continuation prompt', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-BOUNDARY here')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(0)
    expect(stubRuns(world, '1')).toBe(2)
    expect(stubSaw(world, '1', 'cwd')).toBe(path.join(world.root, 'mc-1'))
    expect(stubSaw(world, '1', 'session.2')).not.toBe(stubSaw(world, '1', 'session.1'))
    const second = stubSaw(world, '1', 'prompt.2')
    expect(second.startsWith('# Shift task 1')).toBe(true)
    expect(second).toContain(`Your tree is \`${path.join(world.root, 'mc-1')}\``)
    expect(second).toContain(`${CONTINUE_PROMPT}: the shift report \`${path.join(world.shift, 'report-01.md')}\``)
    expect(second).not.toContain('STUB-BOUNDARY')
    const line = jsonl(path.join(world.shift, 'shift.jsonl')).find(entry => entry.event === 'task')
    expect(line).toMatchObject({ continuations: [stubSaw(world, '1', 'session.2')], lastExit: 'ended', exit: 0, report: true })
    expect(io.out).toContain(`[shift] 01.md 1: stopped at a boundary, restart 1/${MAX_RESTARTS} in ${path.join(world.root, 'mc-1')}`)
  })

  it('w12: a boundary whose report is not a complete handoff is not continued, and the stop names what is missing', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-BOUNDARY STUB-THIN here')
    await runShift([world.shift], shiftDeps(world, captured()))
    expect(stubRuns(world, '1')).toBe(1)
    expect(jsonl(path.join(world.shift, 'shift.jsonl')).find(entry => entry.event === 'task')).toMatchObject({ continuations: [], lastExit: 'boundary' })
    expect(readFileSync(path.join(world.handoff, 'ghosts.jsonl'), 'utf8')).toContain('the handoff lacks current card, queue')
  })

  it('w12: an eddies warn that left no shift report is not continued, and the stop says the report is missing', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-WARN STUB-NOREPORT here')
    await runShift([world.shift], shiftDeps(world, captured()))
    expect(stubRuns(world, '1')).toBe(1)
    expect(readFileSync(path.join(world.handoff, 'ghosts.jsonl'), 'utf8')).toContain('the session wrote no shift report at')
  })

  it('w12: no restart after a boundary under continue: stop', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-BOUNDARY here', 'stop')
    await runShift([world.shift], shiftDeps(world, captured()))
    expect(stubRuns(world, '1')).toBe(1)
    expect(jsonl(path.join(world.shift, 'shift.jsonl')).find(entry => entry.event === 'task')).toMatchObject({ continuations: [], lastExit: 'boundary' })
  })

  it('w12: a session that stops at a boundary every time is restarted at most MAX_RESTARTS times', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-BOUNDARY-ALWAYS here')
    await runShift([world.shift], shiftDeps(world, captured()))
    expect(stubRuns(world, '1')).toBe(1 + MAX_RESTARTS)
    const line = jsonl(path.join(world.shift, 'shift.jsonl')).find(entry => entry.event === 'task')!
    expect(line).toMatchObject({ lastExit: 'boundary' })
    expect(line.continuations).toHaveLength(MAX_RESTARTS)
  })
})

describe('w10: shift:report shows the restarts and why the last session left', () => {
  it('w10: RESULT carries the restart count and the last exit; a journal without them says not recorded', async () => {
    const world = newWorld()
    continuingTask(world, '01.md', '1', 'STUB-WARN-ALWAYS here')
    continuingTask(world, '02.md', '2', 'STUB-STOP here')
    taskFile(world, '03.md', '3', 'scripts/c/**', 'do c')
    await runShift([world.shift], shiftDeps(world, captured()))
    appendFileSync(path.join(world.shift, 'shift.jsonl'), `${JSON.stringify({ event: 'task', file: '04.md', number: '04', task: '4', branch: 'feat/4', session: 's4', worktree: path.join(world.root, 'mc-4'), started: 'x', ended: 'x', exit: 0, signal: null, report: true })}\n`)
    const io = captured()
    expect(runReport([world.shift], reportDeps(world, io))).toBe(0)
    expect(io.out.filter(row => row.startsWith('RESULT'))).toEqual([
      'RESULT   | exit 0 · no PR · not closed · restarts 3/3, last exit eddies warn · eddies stop — · report: did mc-1',
      'RESULT   | exit 0 · no PR · not closed · restarts 0/3, last exit eddies stop · eddies stop session-context 200000/250000 · report: did mc-2',
      'RESULT   | exit 0 · no PR · not closed · restarts 0/3, last exit ended on its own · eddies stop — · report: did mc-3',
      'RESULT   | exit 0 · no PR · not closed · restarts not recorded in shift.jsonl, last exit not recorded in shift.jsonl · eddies stop — · report: no report',
    ])
  })
})

describe('w11: the runner runs shift:merge after the session exits, by the PR #N line of its report', () => {
  const OWNER_MERGES = readFileSync(path.resolve(import.meta.dirname, '../../../architecture/owner-merges.md'), 'utf8')

  function ownerMergesOnMain(world: World): void {
    mkdirSync(path.join(world.repo, 'architecture'))
    writeFileSync(path.join(world.repo, 'architecture', 'owner-merges.md'), OWNER_MERGES)
    git(world.repo, ['add', '.'])
    git(world.repo, ['commit', '-q', '-m', 'owner merges'])
    git(world.repo, ['push', '-q', 'origin', 'main'])
  }

  function decisionTask(world: World, file: string, id: string, decision: 'auto' | 'owner', body: string): void {
    writeFileSync(path.join(world.shift, file), `card: #${id} task-${id} [implement/runner/S/cheap/${decision}] · depends — · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\n\n${body}\n`)
  }

  interface GhCall { args: string[], stubRuns: number, report: boolean }

  function recordingGh(world: World, id: string, calls: GhCall[], decision: 'auto' | 'owner'): (args: string[]) => string {
    return (args) => {
      calls.push({ args, stubRuns: stubRuns(world, id), report: existsSync(path.join(world.shift, `report-0${id}.md`)) })
      if (args.includes('open'))
        return '[]'
      if (args[1] === 'view')
        return JSON.stringify({ body: `#${id} task-${id} [implement/runner/S/cheap/${decision}] · depends — · blocks —\n\nbody`, headRefOid: 'a1b2c3d', files: [{ path: `scripts/${id}/x.ts` }] })
      return ''
    }
  }

  it('w11: a report with PR #N makes the runner call merge with N after the session exited', async () => {
    const world = newWorld()
    ownerMergesOnMain(world)
    decisionTask(world, '01.md', '1', 'auto', 'do a')
    const calls: GhCall[] = []
    const io = captured()
    expect(await runShift([world.shift], { ...shiftDeps(world, io), gh: recordingGh(world, '1', calls, 'auto') })).toBe(0)
    const view = calls.find(call => call.args[1] === 'view')
    expect(view).toMatchObject({ args: ['pr', 'view', '1', '-R', 'E1i/mikoshi-construct', '--json', 'body,headRefOid,files'], stubRuns: 1, report: true })
    expect(calls.find(call => call.args[1] === 'merge')?.args).toEqual(['pr', 'merge', '1', '--auto', '--squash', '--match-head-commit', 'a1b2c3d', '-R', 'E1i/mikoshi-construct'])
    const armed = '[shift:merge] decision auto, no owner path — auto-merge armed on PR #1 at a1b2c3d'
    expect(readFileSync(path.join(world.shift, 'report-01.md'), 'utf8')).toContain(armed)
    expect(jsonl(path.join(world.shift, 'shift.jsonl')).find(line => line.event === 'task')).toMatchObject({ merge: [armed] })
  })

  it('w11: a probe, and an implement report with no PR, call no merge and leave the report as the session wrote it', async () => {
    const world = newWorld()
    ownerMergesOnMain(world)
    taskFile(world, '01.md', '1', 'scripts/a/**', 'probe it', 'probe')
    taskFile(world, '02.md', '2', 'scripts/b/**', 'STUB-NO-PR here')
    const calls: GhCall[] = []
    expect(await runShift([world.shift], { ...shiftDeps(world, captured()), gh: recordingGh(world, '1', calls, 'auto') })).toBe(0)
    expect(calls.filter(call => !call.args.includes('open'))).toEqual([])
    expect(readFileSync(path.join(world.shift, 'report-01.md'), 'utf8')).toBe('result: did mc-1\nPR #1\n')
    expect(readFileSync(path.join(world.shift, 'report-02.md'), 'utf8')).toBe('result: did mc-2\nno PR\n')
    expect(jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task').map(line => line.merge)).toEqual([undefined, undefined])
  })

  it('w11: decision owner arms nothing, and the merge lines land in the report and the journal', async () => {
    const world = newWorld()
    ownerMergesOnMain(world)
    decisionTask(world, '01.md', '1', 'owner', 'do a')
    const calls: GhCall[] = []
    const io = captured()
    expect(await runShift([world.shift], { ...shiftDeps(world, io), gh: recordingGh(world, '1', calls, 'owner') })).toBe(0)
    expect(calls.some(call => call.args[1] === 'merge')).toBe(false)
    const owner = '[shift:merge] decision owner — PR #1 and the report, merge is Eli\'s'
    expect(readFileSync(path.join(world.shift, 'report-01.md'), 'utf8')).toBe(`result: did mc-1\nPR #1\n\n${owner}\n`)
    expect(jsonl(path.join(world.shift, 'shift.jsonl')).find(line => line.event === 'task')).toMatchObject({ merge: [owner] })
    expect(io.out).toContain(owner)
  })

  it('w11: a merge that throws is recorded as a line and the shift goes on', async () => {
    const world = newWorld()
    decisionTask(world, '01.md', '1', 'auto', 'do a')
    decisionTask(world, '02.md', '2', 'auto', 'do b')
    const io = captured()
    expect(await runShift([world.shift], shiftDeps(world, io))).toBe(0)
    const merges = jsonl(path.join(world.shift, 'shift.jsonl')).filter(line => line.event === 'task').map(line => line.merge as string[])
    expect(merges).toHaveLength(2)
    for (const lines of merges)
      expect(lines[0]).toMatch(/^\[shift:merge\] /)
  })
})

const OWNER_KIND = 'implement/runner/S/cheap/owner'
const CHAIN_HEAD = 'a1b2c3d'

interface ChainGh {
  gh: (args: string[]) => string
  calls: string[][]
}

function chainGh(options: { ownerMergedAfterViews?: number, checks?: { name: string, status: string, conclusion: string }[], owner?: number[], state?: string, unreadable?: string } = {}): ChainGh {
  const owner = options.owner ?? []
  const inner = fakeGh({ 101: parkedCardLine(1, owner.includes(101) ? OWNER_KIND : undefined), 102: parkedCardLine(2, owner.includes(102) ? OWNER_KIND : undefined, '#1'), 103: parkedCardLine(3) })
  const calls: string[][] = []
  const views = new Map<number, number>()
  const gh = (args: string[]): string => {
    calls.push(args)
    const number = Number(args[2])
    if (args[1] === 'view' && args.at(-1) === 'headRefName,headRefOid,state') {
      if (options.unreadable !== undefined)
        throw new Error(options.unreadable)
      return JSON.stringify({ headRefName: `feat/${number - 100}`, headRefOid: CHAIN_HEAD, state: options.state ?? 'OPEN' })
    }
    if (args[1] === 'view' && args.at(-1) === 'headRefName,headRefOid')
      return JSON.stringify({ headRefName: `feat/${number - 100}`, headRefOid: CHAIN_HEAD })
    if (args[1] === 'view' && args.at(-1) === 'headRefOid,statusCheckRollup,files')
      return JSON.stringify({ headRefOid: CHAIN_HEAD, statusCheckRollup: options.checks ?? [{ name: 'required', status: 'IN_PROGRESS', conclusion: '' }], files: [] })
    if (args[1] === 'view' && owner.includes(number) && args.at(-1) !== 'body,headRefOid,files') {
      const seen = (views.get(number) ?? 0) + 1
      views.set(number, seen)
      if (options.ownerMergedAfterViews !== undefined && seen > options.ownerMergedAfterViews)
        return JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-06T00:30:00Z', mergedBy: { login: 'E1i' }, mergeCommit: { oid: 'c0ffee' }, body: `${parkedCardLine(number - 100, OWNER_KIND)}\n\nbody` })
    }
    return inner.gh(args)
  }
  return { gh, calls }
}

function chainRun(world: ReturnType<typeof newChainWorld>, gh: ChainGh, extra: string[] = [], deps: Partial<ShiftDeps> = {}): Promise<{ code: number, io: ReturnType<typeof capturedIo>, slept: number[] }> {
  const io = capturedIo()
  const slept: number[] = []
  const sleep = (ms: number): Promise<void> => {
    slept.push(ms)
    return Promise.resolve()
  }
  for (const pr of [101, 102, 103])
    writeFileSync(world.journal, `${JSON.stringify({ event: 'pr-review', task: String(pr - 100), pr, verdict: 'pass', commit: CHAIN_HEAD })}\n`, { flag: 'a' })
  return runShift([world.shift, '--parking', world.parking, '--chain', ...extra], chainDepsOf(world, gh.gh, io, { sleep, ...deps })).then(code => ({ code, io, slept }))
}

function chainSteps(world: ReturnType<typeof newChainWorld>): string[] {
  return eventsOf(world, 'chain').filter(line => line.step !== 'reviewed').map(line => `${String(line.step)}${line.task === undefined ? '' : ` ${String(line.task)}`}${line.reason === undefined ? '' : ` ${String(line.reason)}`}`)
}

const A_AND_B = [{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, { id: 2, depends: '#1', body: 'do 2 STUB-VERIFIED-run STUB-PR-102' }]

describe('a shift continues itself: --chain waits for the merge and takes the next card', () => {
  it('a merged card A starts card B that depends on A without a window', async () => {
    const world = newChainWorld(A_AND_B)
    const gh = chainGh()
    const { code } = await chainRun(world, gh)
    expect(code).toBe(0)
    expect(chainSteps(world)).toEqual(['wait 1', 'merged 1', 'next 2', 'wait 2', 'merged 2', 'end no-eligible'])
    expect(eventsOf(world, 'merge').map(line => line.task)).toEqual(['1', '2'])
    expect(readFileSync(path.join(world.stubOut, 'mc-2.cwd'), 'utf8').trim()).toBe(path.join(world.root, 'mc-2'))
  })

  it('the chain goes on after the window closes', async () => {
    const world = newChainWorld(A_AND_B)
    const gh = chainGh({ owner: [101], ownerMergedAfterViews: 1 })
    const events: string[] = []
    const listeners = new Set<() => void>()
    const proc = {
      on: (_: string, listener: () => void) => {
        listeners.add(listener)
        events.push('hold')
      },
      off: (_: string, listener: () => void) => {
        listeners.delete(listener)
        events.push('release')
      },
    }
    const sleep = (): Promise<void> => {
      events.push('sleep')
      for (const listener of listeners)
        listener()
      events.push('hangup')
      return Promise.resolve()
    }
    const { code } = await chainRun(world, gh, ['--chain-wait', '600'], { sleep, holdHangup: () => holdThroughHangup(proc as never) })
    expect(code).toBe(0)
    expect(events).toEqual(['hold', 'sleep', 'hangup', 'release'])
    expect(chainSteps(world)).toEqual(['wait 1', 'merged 1', 'next 2', 'wait 2', 'merged 2', 'end no-eligible'])
  })

  it('the running observation follows the task\'s journal line', async () => {
    const world = newChainWorld(A_AND_B)
    const taskLinesAtBoundary: string[] = []
    const observeChain: ShiftDeps['observeChain'] = (moment) => {
      if (moment.state === 'running' && moment.boundary)
        taskLinesAtBoundary.push(`${moment.cardId}: ${jsonl(path.join(world.shift, 'shift.jsonl')).filter(entry => entry.event === 'task').length}`)
    }
    await chainRun(world, chainGh(), [], { observeChain })
    expect(taskLinesAtBoundary).toEqual(['1: 1', '2: 2'])
  })

  it('a question stops the chain', async () => {
    const world = newChainWorld([{ id: 1, body: 'do 1 STUB-QUESTION STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    const { gh, calls } = chainGh()
    await chainRun(world, { gh, calls })
    expect(chainSteps(world)).toEqual(['end question'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'question' }])
    expect(existsSync(path.join(world.stubOut, 'mc-2.runs'))).toBe(false)
  })

  it('a required check that turns red while waiting for the merge stops the chain', async () => {
    const world = newChainWorld([{ id: 1, kind: OWNER_KIND, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    const gh = chainGh({ owner: [101], checks: [{ name: 'required', status: 'COMPLETED', conclusion: 'FAILURE' }] })
    await chainRun(world, gh)
    expect(chainSteps(world)).toEqual(['wait 1', 'end red-check'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101, why: expect.stringContaining('turned red') as unknown }])
    expect(gh.calls.filter(args => args[1] === 'merge')).toEqual([])
  })

  it('no merge before the timeout ends the chain with a report', async () => {
    const world = newChainWorld([{ id: 1, kind: OWNER_KIND, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    const gh = chainGh({ owner: [101] })
    const { slept } = await chainRun(world, gh, ['--chain-wait', '3'])
    expect(slept.length).toBeGreaterThan(0)
    expect(chainSteps(world)).toEqual(['wait 1', 'end merge-timeout'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101, why: expect.stringContaining('not merged within 3 minutes') as unknown }])
    expect(gh.calls.filter(args => args[1] === 'merge')).toEqual([])
  })

  it('no eligible card ends the chain with a report', async () => {
    const world = newChainWorld([A_AND_B[0]!, { id: 3, who: 'window' }])
    const { code, io } = await chainRun(world, chainGh())
    expect(code).toBe(0)
    expect(chainSteps(world)).toEqual(['wait 1', 'merged 1', 'end no-eligible'])
    expect(io.out).toContain('[shift] chain ended: no-eligible')
  })

  it('the time limit and the card budget end the chain with a report', async () => {
    const limited = newChainWorld(A_AND_B)
    await chainRun(limited, chainGh(), ['--chain-limit', '1'])
    expect(chainSteps(limited)).toEqual(['wait 1', 'merged 1', 'end time-limit'])
    const budgeted = newChainWorld(A_AND_B)
    await chainRun(budgeted, chainGh(), ['--chain-cards', '1'])
    expect(chainSteps(budgeted)).toEqual(['wait 1', 'merged 1', 'end card-budget'])
  })

  it('an owner PR in a chain is armed only under the shard issued for it', async () => {
    const world = newChainWorld([{ id: 1, kind: OWNER_KIND, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }])
    copyFileSync(path.resolve(import.meta.dirname, '../../../construct.json'), path.join(world.repo, 'construct.json'))
    const shard = '5a4d0000-0000-4000-8000-000000000652'
    writeFileSync(world.journal, `${JSON.stringify({ event: 'shard', id: shard, by: 'Eli', ts: '2026-10-08T09:00:00.000Z', run: world.shift })}\n`, { flag: 'a' })
    const gh = chainGh({ owner: [101] })
    await chainRun(world, gh, ['--slot', shard])
    expect(gh.calls.filter(args => args[1] === 'merge')).toHaveLength(1)
    expect(eventsOf(world, 'delegated')).toMatchObject([{ task: '1', pr: 101, shard }])
    expect(chainSteps(world)).toEqual(['wait 1', 'merged 1', 'end no-eligible'])
  })

  it('a guard refusal stops the chain', async () => {
    const world = newChainWorld([{ id: 1, body: 'do 1 STUB-REFUSED STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    await chainRun(world, chainGh())
    expect(chainSteps(world)).toEqual(['end guard-refusal'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault' }])
    expect(existsSync(path.join(world.stubOut, 'mc-2.runs'))).toBe(false)
  })

  it('a session stopped on its Eddies budget ends the chain with eddies-budget', async () => {
    const world = newChainWorld([{ id: 1, body: 'do 1 STUB-STOP STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    await chainRun(world, chainGh())
    expect(chainSteps(world)).toEqual(['end eddies-budget'])
    expect(existsSync(path.join(world.stubOut, 'mc-2.runs'))).toBe(false)
  })

  it('a guard refusal masked by task:close stops the chain', async () => {
    const world = newChainWorld([{ id: 1, body: 'do 1 STUB-CLOSE STUB-REFUSED STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    await chainRun(world, chainGh())
    expect(chainSteps(world)).toEqual(['end guard-refusal'])
    expect(existsSync(path.join(world.stubOut, 'mc-2.runs'))).toBe(false)
    expect(readFileSync(path.join(world.shift, 'shift-report.md'), 'utf8')).toContain('| #1 task-1 | stop guard-refusal | guard refusal | PR #101 |')
  })

  it('an Eddies stop masked by task:close ends the chain with eddies-budget', async () => {
    const world = newChainWorld([{ id: 1, body: 'do 1 STUB-CLOSE STUB-STOP STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    await chainRun(world, chainGh())
    expect(chainSteps(world)).toEqual(['end eddies-budget'])
    expect(existsSync(path.join(world.stubOut, 'mc-2.runs'))).toBe(false)
  })

  it.each([
    ['STUB-REFUSED', 'guard-refusal'],
    ['STUB-STOP', 'eddies-budget'],
  ])('a %s masked by task:close in a session that exits 1 is no failure and still ends the chain with %s', async (marker, end) => {
    const world = newChainWorld([{ id: 1, body: `do 1 STUB-CLOSE ${marker} STUB-FAIL` }, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' }])
    await chainRun(world, chainGh())
    expect(chainSteps(world)).toEqual([`end ${end}`])
    expect(eventsOf(world, 'stop')[0]).not.toHaveProperty('failed')
    expect(existsSync(path.join(world.stubOut, 'mc-2.runs'))).toBe(false)
  })

  it('a pull request closed without a merge ends the chain at once', async () => {
    const world = newChainWorld([{ id: 1, kind: OWNER_KIND, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    const { slept } = await chainRun(world, chainGh({ owner: [101], state: 'CLOSED' }))
    expect(slept).toEqual([])
    expect(chainSteps(world)).toEqual(['wait 1', 'end pr-closed'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101, why: 'PR #101 was closed without a merge' }])
  })

  it('a merge timeout names the gh fault that kept the pull request unread', async () => {
    const world = newChainWorld([{ id: 1, kind: OWNER_KIND, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, ...A_AND_B.slice(1)])
    await chainRun(world, chainGh({ owner: [101], unreadable: 'gh: HTTP 502\nmore' }), ['--chain-wait', '3'])
    expect(chainSteps(world)).toEqual(['wait 1', 'end merge-timeout'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', why: 'PR #101 not merged within 3 minutes; gh could not read it: gh: HTTP 502' }])
  })

  it('a chain spawns its sessions detached and a plain run does not', async () => {
    const detached: (boolean | undefined)[] = []
    const run: ShiftDeps['run'] = (claudeRun) => {
      detached.push(claudeRun.detached)
      return runClaude(claudeRun)
    }
    await chainRun(newChainWorld([A_AND_B[0]!]), chainGh(), [], { run })
    const plain = newChainWorld([A_AND_B[0]!])
    await runShift([plain.shift, '--parking', plain.parking], chainDepsOf(plain, chainGh().gh, capturedIo(), { run }))
    expect(detached).toEqual([true, undefined])
  })

  it('the hangup hold ignores stream errors on a closed terminal until it is released', () => {
    const listeners = { process: new Map<string, () => void>(), stdout: new Map<string, () => void>(), stderr: new Map<string, () => void>() }
    const fake = (map: Map<string, () => void>) => ({ on: (event: string, listener: () => void) => map.set(event, listener), off: (event: string) => map.delete(event) })
    const release = holdThroughHangup({ ...fake(listeners.process), stdout: fake(listeners.stdout), stderr: fake(listeners.stderr) } as never)
    expect([[...listeners.process.keys()], [...listeners.stdout.keys()], [...listeners.stderr.keys()]]).toEqual([['SIGHUP'], ['error'], ['error']])
    release()
    expect([listeners.process.size, listeners.stdout.size, listeners.stderr.size]).toEqual([0, 0, 0])
  })

  it('--chain refuses a run without --parking, with --manual, or with a wait that is not a number', async () => {
    const world = newChainWorld(A_AND_B)
    const io = capturedIo()
    expect(await runShift([world.shift, '--chain'], chainDepsOf(world, chainGh().gh, io))).toBe(1)
    expect(await runShift([world.shift, '--parking', world.parking, '--chain', '--manual'], chainDepsOf(world, chainGh().gh, io))).toBe(1)
    expect(await runShift([world.shift, '--parking', world.parking, '--chain', '--chain-wait', 'soon'], chainDepsOf(world, chainGh().gh, io))).toBe(1)
    expect(existsSync(path.join(world.shift, 'shift.jsonl'))).toBe(false)
  })
})

describe('a failed card does not stop the shift', () => {
  const A_FAILS = { id: 1, body: 'do 1 STUB-FAIL' }
  const notes = (): { notify: ShiftDeps['notify'], seen: [string, string][] } => {
    const seen: [string, string][] = []
    return { notify: (title, message) => seen.push([title, message]), seen }
  }

  it('a failed card A does not stop the shift and the independent card B merges', async () => {
    const world = newChainWorld([A_FAILS, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' }])
    await chainRun(world, chainGh())
    expect(chainSteps(world)).toEqual(['next 2', 'wait 2', 'merged 2', 'end no-eligible'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault', why: 'exit 1' }])
    expect(eventsOf(world, 'merge').map(line => line.task)).toEqual(['2'])
  })

  it('a card C that depends on a failed card is skipped with depends failed', async () => {
    const world = newChainWorld([A_FAILS, { id: 3, depends: '#1', body: 'do 3 STUB-VERIFIED-run STUB-PR-103' }])
    const { io } = await chainRun(world, chainGh())
    expect(chainSteps(world)).toEqual(['end no-eligible'])
    expect(existsSync(path.join(world.stubOut, 'mc-3.runs'))).toBe(false)
    expect(readFileSync(path.join(world.shift, 'shift-report.md'), 'utf8')).toContain('| #3 | skipped | depends failed #1 | — |')
    expect(io.out).toContain(`[shift] outcomes: 1 failed, 1 skipped; ${path.join(world.shift, 'shift-report.md')}`)
  })

  it('a failed card calls the notifier with its number, its reason and the shift report, and the end of the shift calls it once more', async () => {
    const world = newChainWorld([A_FAILS, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' }])
    const { notify, seen } = notes()
    await chainRun(world, chainGh(), [], { notify })
    const report = path.join(world.shift, 'shift-report.md')
    expect(seen).toEqual([['shift: #1 failed', `exit 1 — ${report}`], ['shift over', `2 cards · 1 failed · 0 skipped — ${report}`]])
  })

  it('the shift report has a failed row, a done row with its PR, and the last line of the failed session', async () => {
    const world = newChainWorld([{ id: 1, body: 'do 1 STUB-FAIL STUB-SAY-tests-red' }, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' }])
    await chainRun(world, chainGh())
    const table = readFileSync(path.join(world.shift, 'shift-report.md'), 'utf8').split('\n')
    expect(table.slice(0, 2)).toEqual(['| card | result | reason | PR |', '|------|--------|--------|----|'])
    expect(table).toContain('| #1 task-1 | failed | exit 1 · tests-red | — |')
    expect(table).toContain('| #2 task-2 | done | — | PR #102 |')
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault', last: 'tests-red' }])
  })
})
