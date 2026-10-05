import type { ShiftDeps } from '../../shift/shift.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VERIFICATION_WORDS } from '../../board/verification.js'
import { runClaude } from '../../shift/claude.js'
import { runShift } from '../../shift/shift.js'

const STUB = path.join(import.meta.dirname, 'fixtures', 'claude-stub.sh')
const HEADER = readFileSync(path.join(import.meta.dirname, '../../shift/header.md'), 'utf8')
const T0 = Date.parse('2026-10-05T01:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

interface World { root: string, repo: string, handoff: string, shift: string, stubOut: string, parking: string, journal: string }

function cardLine(id: number, depends = '—'): string {
  return `#${id} task-${id} [implement/runner/S/cheap/auto] · depends ${depends} · blocks —`
}

function newWorld(journalLines: object[], cards: { id: number, depends?: string, body?: string }[]): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-merged-')))
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
  const parking = path.join(root, 'parking')
  const handoff = path.join(root, 'handoff')
  for (const dir of [shift, stubOut, parking, handoff])
    mkdirSync(dir)
  for (const { id, depends, body } of cards)
    writeFileSync(path.join(parking, `${id}.md`), `card: ${cardLine(id, depends)}\nbranch: feat/${id}\ntouches: scripts/${id}/**\nwho: shift\n\n${body ?? `do ${id}`}\n`)
  const journal = path.join(handoff, 'ghosts.jsonl')
  const intake = cards.map(({ id, depends }) => ({ event: 'intake', task: String(id), card: cardLine(id, depends), confirmation: 'none', corrections: [], ts: '2026-10-05T00:00:00.000Z' }))
  writeFileSync(journal, [...journalLines, ...intake].map(line => `${JSON.stringify(line)}\n`).join(''))
  return { root, repo, handoff, shift, stubOut, parking, journal }
}

function depsOf(world: World, gh: (args: string[]) => string, out: string[], err: string[]): ShiftDeps {
  let ticks = 0
  let uuids = 0
  return {
    cwd: world.repo,
    claude: `STUB_OUT=${world.stubOut} CONSTRUCT_HANDOFF_DIR=${world.handoff} sh ${STUB}`,
    header: HEADER,
    handoffDir: world.handoff,
    readJournal: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    projectsDir: path.join(world.root, 'projects'),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    install: () => {},
    gh,
    listDir: dir => readdirSync(dir),
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(T0 + 61_000 * ticks++),
    uuid: () => `00000000-0000-4000-8000-00000000000${++uuids}`,
    run: runClaude,
    out: line => out.push(line),
    err: line => err.push(line),
  }
}

function mergeLines(world: World): Record<string, unknown>[] {
  return readFileSync(world.journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'merge')
}

const DONE_1 = { event: 'path', task: '1', path: 'cheap', pr: 600, verification: 'run' }
const DONE_9 = { event: 'path', task: 'ghost-nine', path: 'ladder', pr: 609, verification: 'run' }

function ghMerged(merged: Record<number, number>, laterMerged: Record<number, number> = {}): { gh: (args: string[]) => string, calls: string[][] } {
  const calls: string[][] = []
  const seen = new Map<number, number>()
  const gh = (args: string[]): string => {
    calls.push(args)
    if (args[0] !== 'pr' || args[1] !== 'view')
      return '[]'
    const number = Number(args[2])
    const count = (seen.get(number) ?? 0) + 1
    seen.set(number, count)
    const card = merged[number] ?? (count > 1 ? laterMerged[number] : undefined)
    const state = card === undefined ? 'OPEN' : 'MERGED'
    return JSON.stringify({ state, mergedAt: card === undefined ? null : '2026-10-05T00:30:00Z', mergedBy: card === undefined ? null : { login: 'E1i' }, mergeCommit: card === undefined ? null : { oid: 'c0ffee' }, body: `${cardLine(card ?? number)}\n\nbody` })
  }
  return { gh, calls }
}

describe('the shift records merged pull requests', () => {
  it('records merged pull requests before it chooses and once after the last task', async () => {
    const world = newWorld([DONE_1, DONE_9], [{ id: 1 }, { id: 2, depends: '#1' }])
    const { gh } = ghMerged({ 600: 1 }, { 609: 9 })
    const out: string[] = []
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, out, []))
    expect(out[0]).toBe('[shift] parking: takes #2')
    expect(mergeLines(world).map(line => [line.task, line.pr])).toEqual([['1', 600], ['9', 609]])
  })

  it('prints one merged line for 3 carded and 30 card-less pull requests, writes the details to merged.txt, and a rerun asks gh about none of the 30', async () => {
    const carded = [700, 701, 702]
    const cardless = Array.from({ length: 30 }, (_, index) => 800 + index)
    const closing = [...carded, ...cardless].map(pr => ({ event: 'path', task: `ghost-${pr}`, path: 'ladder', pr, verification: 'run' }))
    const world = newWorld(closing, [{ id: 2 }])
    const calls: string[] = []
    const gh = (args: string[]): string => {
      if (args[0] !== 'pr' || args[1] !== 'view')
        return '[]'
      calls.push(args[2]!)
      const pr = Number(args[2])
      const body = carded.includes(pr) ? `${cardLine(pr - 600)}\n\nbody` : 'an old pull request'
      return JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-05T00:30:00Z', mergedBy: { login: 'E1i' }, mergeCommit: { oid: 'c0ffee' }, body })
    }
    const err: string[] = []
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, [], err))
    expect(err.filter(line => line.startsWith('[shift] merged'))).toEqual([`[shift] merged: 3 new · 30 PRs without a card skipped; details in ${path.join(world.shift, 'merged.txt')}`])
    expect(readFileSync(path.join(world.shift, 'merged.txt'), 'utf8').split('\n').filter(line => line !== '')).toHaveLength(33)
    expect(mergeLines(world).map(line => [line.task, line.pr])).toEqual([['100', 700], ['101', 701], ['102', 702]])
    calls.length = 0
    const rerun = path.join(world.root, 'shift-2')
    mkdirSync(rerun)
    await runShift([rerun, '--parking', world.parking], depsOf(world, gh, [], []))
    expect(calls).toEqual([])
  })

  it('does not fail the shift when gh throws', async () => {
    const world = newWorld([DONE_1], [{ id: 2 }])
    const err: string[] = []
    const out: string[] = []
    const code = await runShift([world.shift, '--parking', world.parking], depsOf(world, () => {
      throw new Error('gh down')
    }, out, err))
    expect(out[0]).toBe('[shift] parking: takes #2')
    expect(code).toBe(0)
    expect(mergeLines(world)).toEqual([])
  })

  it('--check writes no merge line, runs no pr view and prints the hint to run pnpm task:merged', async () => {
    const world = newWorld([DONE_1], [{ id: 2, depends: '#1' }, { id: 3 }])
    const before = readFileSync(world.journal, 'utf8')
    const { gh, calls } = ghMerged({ 600: 1 })
    const out: string[] = []
    const code = await runShift([world.shift, '--parking', world.parking, '--check'], depsOf(world, gh, out, []))
    expect(readFileSync(world.journal, 'utf8')).toBe(before)
    expect(calls.filter(args => args[1] === 'view')).toEqual([])
    expect(out).toContain('[shift] hint: depends are met by merge lines; run pnpm task:merged to record merged pull requests')
    expect(code).toBe(0)
  })
})

function closingLines(world: World): Record<string, unknown>[] {
  return readFileSync(world.journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'path' && 'pr' in line)
}

describe('the shift closes a task from its report', () => {
  it('a report with PR #N and verification: run leaves a task:close line, and the next parking choice does not take the card', async () => {
    const world = newWorld([], [{ id: 2, body: 'do 2 STUB-VERIFIED-run' }])
    const { gh } = ghMerged({})
    const out: string[] = []
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, out, []))
    expect(closingLines(world)).toMatchObject([{ task: '2', path: 'cheap', pr: 1, verification: 'run' }])
    expect(out.some(line => line.includes('closed run · PR #1'))).toBe(true)
    const next: string[] = []
    const rerun = path.join(world.root, 'shift-2')
    mkdirSync(rerun)
    await runShift([rerun, '--parking', world.parking, '--check'], depsOf(world, gh, next, []))
    expect(next[0]).toBe('[shift] parking: takes none')
  })

  it('a report with PR #N and no verification line writes no closing line and prints the red line naming the missing word', async () => {
    const world = newWorld([], [{ id: 2 }])
    const { gh } = ghMerged({})
    const out: string[] = []
    const paint = (tone: string | undefined, text: string): string => tone === 'red' ? `<red>${text}</red>` : text
    await runShift([world.shift, '--parking', world.parking], { ...depsOf(world, gh, out, []), style: { ascii: true, paint } })
    expect(closingLines(world)).toEqual([])
    expect(out).toContain('<red>[shift] #2 not closed: the report has no verification: <word> line, one of measurement, code-reading, run, review, mutation, browser, human-gate; no closing line written</red>')
  })

  it('a verification word outside the list writes no closing line and the red line names the word', async () => {
    const world = newWorld([], [{ id: 2, body: 'do 2 STUB-VERIFIED-hunch' }])
    const { gh } = ghMerged({})
    const out: string[] = []
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, out, []))
    expect(closingLines(world)).toEqual([])
    expect(out).toContain('[shift] #2 not closed: verification \'hunch\' is not one of measurement, code-reading, run, review, mutation, browser, human-gate; nothing written')
  })

  it('the header names every verification word the shift accepts', () => {
    for (const word of VERIFICATION_WORDS)
      expect(HEADER).toContain(`\`${word}\``)
  })
})
