import type { ShiftDeps } from '../../shift/shift.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runShift } from '../../shift/shift.js'

const HEADER = readFileSync(path.join(import.meta.dirname, '../../shift/header.md'), 'utf8')
const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

interface World {
  root: string
  repo: string
  handoff: string
  shift: string
}

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-entry-world-')))
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
  mkdirSync(shift)
  return { root, repo, handoff: path.join(root, 'handoff'), shift }
}

function parkedCardLines(dir: string): string[] {
  return readdirSync(dir).filter(file => file.endsWith('.md')).flatMap(file => /^card: (.+)$/m.exec(readFileSync(path.join(dir, file), 'utf8'))?.[1] ?? [])
}

function shiftDeps(world: World, out: string[]): ShiftDeps {
  let ticks = 0
  let uuids = 0
  return {
    cwd: world.repo,
    claude: 'true',
    header: HEADER,
    handoffDir: world.handoff,
    readJournal: file => (existsSync(file) ? readFileSync(file, 'utf8') : '') + parkedCardLines(world.shift).map(line => `${JSON.stringify({ event: 'intake', task: /^#(\d+)/.exec(line)![1], card: line, confirmation: 'none', corrections: [], ts: '2026-10-03T00:00:00.000Z' })}\n`).join(''),
    projectsDir: path.join(world.root, 'projects'),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    install: () => {},
    gh: () => '[]',
    listDir: dir => readdirSync(dir),
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(Date.parse('2026-10-05T01:00:00.000Z') + 61000 * ticks++),
    uuid: () => `00000000-0000-4000-8000-00000000000${++uuids}`,
    run: async () => ({ kind: 'exited', code: 0, signal: null }),
    out: line => out.push(line),
    err: () => {},
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fieldsOf(rows: string[]): Record<string, string> {
  return Object.fromEntries(rows.filter(row => /^(?:CONTRACT|EXPECT) /.test(row)).slice(0, 2).map(row => [row.split(' ')[0]!, row.replace(/^\w+\s+\| /, '')]))
}

describe('the shift writes into the entry line the CONTRACT and the EXPECT it printed', () => {
  it('writes the CONTRACT and the EXPECT it printed for a card with two touches', async () => {
    const world = newWorld()
    writeFileSync(path.join(world.shift, '01.md'), 'card: #1 task-1 [implement/runner/S/cheap/auto] · depends — · blocks —\nbranch: feat/1\ntouches: a.ts, b/**\n\ndo a\n')
    const out: string[] = []
    await runShift([world.shift], shiftDeps(world, out))
    const printed = fieldsOf(out)
    expect(printed.CONTRACT).toBe('implement · cheap · auto · touches a.ts, b/** · law not recorded in the task file')
    const entry = readFileSync(path.join(world.handoff, 'ghosts.jsonl'), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.event === 'entry')!
    expect(entry.CONTRACT).toBe(printed.CONTRACT)
    expect(entry.EXPECT).toBe(printed.EXPECT)
    expect(entry.schema).toBe(2)
  })

  it('writes the EXPECT of a forecast that holds data, not the not-recorded sentence', async () => {
    const world = newWorld()
    const lines = Array.from({ length: 5 }, (_, index) => {
      const worktree = path.join(world.root, `mc-past-${index}`)
      const session = `past-${index}`
      const sessionFile = path.join(world.root, 'projects', worktree.replace(/[/.]/g, '-'), `${session}.jsonl`)
      mkdirSync(path.dirname(sessionFile), { recursive: true })
      writeFileSync(sessionFile, `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', usage: { input_tokens: 1000 * (index + 1), output_tokens: 0 } } })}\n`)
      const card = { id: 900 + index, name: `past-${index}`, kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', depends: [], blocks: [], line: '' }
      return JSON.stringify({ event: 'task', file: '01.md', number: '01', task: String(900 + index), card, branch: `past/${index}`, session, started: '2026-10-01T00:00:00.000Z', worktree, ended: `2026-10-01T00:0${index + 1}:00.000Z`, exit: 0, signal: null, report: true, continuations: [] })
    })
    mkdirSync(path.join(world.root, 'past-S'))
    writeFileSync(path.join(world.root, 'past-S', 'shift.jsonl'), `${lines.join('\n')}\n`)
    writeFileSync(path.join(world.shift, '01.md'), 'card: #1 task-1 [implement/runner/S/cheap/auto] · depends — · blocks —\nbranch: feat/1\ntouches: a.ts, b/**\n\ndo a\n')
    const out: string[] = []
    await runShift([world.shift], shiftDeps(world, out))
    const entry = readFileSync(path.join(world.handoff, 'ghosts.jsonl'), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.event === 'entry')!
    expect(fieldsOf(out).EXPECT).toContain('expect tokens ≈ 3k')
    expect(entry.EXPECT).toBe(fieldsOf(out).EXPECT)
  })
})

describe('cONSTRUCT_CLOUD', () => {
  it('shift with CONSTRUCT_CLOUD=1 spawns no local session', async () => {
    const world = newWorld()
    writeFileSync(path.join(world.shift, '01.md'), 'card: #1 task-1 [implement/runner/S/cheap/auto] · depends — · blocks —\nbranch: feat/1\ntouches: a.ts\n\ndo a\n')
    const out: string[] = []
    const err: string[] = []
    let spawned = 0
    const deps = { ...shiftDeps(world, out), err: (line: string) => err.push(line), run: async () => {
      spawned++
      return { kind: 'exited' as const, code: 0, signal: null }
    } }
    expect(await runShift([world.shift], { ...deps, cloud: true })).toBe(1)
    expect(spawned).toBe(0)
    expect(err.join('\n')).toContain('CONSTRUCT_CLOUD=1')
    expect(existsSync(path.join(world.shift, 'shift.jsonl'))).toBe(false)
    expect(existsSync(world.handoff)).toBe(false)
  })

  it('shift --check with CONSTRUCT_CLOUD=1 exits 0 as it does locally and prints no refusal', async () => {
    const world = newWorld()
    writeFileSync(path.join(world.shift, '01.md'), 'card: #1 task-1 [implement/runner/S/cheap/auto] · depends — · blocks —\nbranch: feat/1\ntouches: a.ts\n\ndo a\n')
    const out: string[] = []
    const err: string[] = []
    let spawned = 0
    const deps = { ...shiftDeps(world, out), err: (line: string) => err.push(line), run: async () => {
      spawned++
      return { kind: 'exited' as const, code: 0, signal: null }
    } }
    expect(await runShift([world.shift, '--check'], { ...deps, cloud: true })).toBe(0)
    expect(spawned).toBe(0)
    expect(err.join('\n')).not.toContain('CONSTRUCT_CLOUD=1')
    expect(existsSync(path.join(world.shift, 'shift.jsonl'))).toBe(false)
  })
})
