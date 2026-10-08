import type { ShiftDeps } from '../../../shift/shift.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { runClaude } from '../../../shift/claude.js'
import './stub-handoff.js'

const STUB = path.join(import.meta.dirname, 'claude-stub-pr.sh')
export const HEADER = readFileSync(path.join(import.meta.dirname, '../../../shift/header.md'), 'utf8')
const OWNER_MERGES = readFileSync(path.resolve(import.meta.dirname, '../../../../architecture/owner-merges.md'), 'utf8')
const T0 = Date.parse('2026-10-06T01:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

export interface World {
  root: string
  repo: string
  handoff: string
  shift: string
  stubOut: string
  parking: string
  journal: string
}

export interface ParkedCard {
  id: number
  kind?: string
  who?: string
  body?: string
  header?: string
  intake?: boolean
  depends?: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

export function cardLine(id: number, kind = 'implement/runner/S/cheap/auto', depends = '—'): string {
  return `#${id} task-${id} [${kind}] · depends ${depends} · blocks —`
}

export function newWorld(cards: ParkedCard[]): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'autopilot-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  mkdirSync(path.join(repo, 'architecture'))
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  writeFileSync(path.join(repo, 'architecture', 'owner-merges.md'), OWNER_MERGES)
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  const dirs = { shift: path.join(root, 'shift'), stubOut: path.join(root, 'stub-out'), parking: path.join(root, 'parking'), handoff: path.join(root, 'handoff') }
  for (const dir of Object.values(dirs))
    mkdirSync(dir)
  for (const { id, kind, who, body, header, depends } of cards)
    writeFileSync(path.join(dirs.parking, `${id}.md`), `card: ${cardLine(id, kind, depends)}\nbranch: feat/${id}\ntouches: scripts/${id}/**\nwho: ${who ?? 'shift'}\n${header ?? ''}\n${body ?? `do ${id}`}\n`)
  const journal = path.join(dirs.handoff, 'ghosts.jsonl')
  const intake = cards.filter(card => card.intake !== false).map(({ id, kind, depends }) => ({ event: 'intake', task: String(id), card: cardLine(id, kind, depends), confirmation: 'none', corrections: [], ts: '2026-10-06T00:00:00.000Z' }))
  writeFileSync(journal, intake.map(line => `${JSON.stringify(line)}\n`).join(''))
  return { root, repo, ...dirs, journal }
}

export interface Captured {
  out: string[]
  err: string[]
}

export function depsOf(world: World, gh: (args: string[]) => string, io: Captured, extra: Partial<ShiftDeps> = {}): ShiftDeps {
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
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`,
    run: runClaude,
    out: line => io.out.push(line),
    err: line => io.err.push(line),
    ...extra,
  }
}

export interface FakeGh {
  gh: (args: string[]) => string
  calls: string[][]
}

export function fakeGh(prCards: Record<number, string>): FakeGh {
  const calls: string[][] = []
  const armed = new Set<number>()
  const gh = (args: string[]): string => {
    calls.push(args)
    if (args.includes('open'))
      return '[]'
    const number = Number(args[2])
    if (args[1] === 'merge') {
      armed.add(number)
      return ''
    }
    if (args[1] !== 'view' || prCards[number] === undefined)
      return '[]'
    if (args.at(-1) === 'body,headRefOid,files')
      return JSON.stringify({ body: `${prCards[number]}\n\nbody`, headRefOid: 'a1b2c3d', files: [{ path: `scripts/${number - 100}/x.ts` }] })
    const merged = armed.has(number)
    return JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergedAt: merged ? '2026-10-06T00:30:00Z' : null, mergedBy: merged ? { login: 'E1i' } : null, mergeCommit: merged ? { oid: 'c0ffee' } : null, body: `${prCards[number]}\n\nbody` })
  }
  return { gh, calls }
}

export function captured(): Captured {
  return { out: [], err: [] }
}

export function lines(file: string): Record<string, unknown>[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

export function eventsOf(world: World, event: string): Record<string, unknown>[] {
  return lines(world.journal).filter(line => line.event === event)
}

export function stubRuns(world: World, id: number): number {
  const file = path.join(world.stubOut, `mc-${id}.runs`)
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
}
