import type { TaskStartDeps } from '../../ghosts/task-start.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bodySha, bodyShaWithoutTouches, INTAKE_EVENT } from '../../../src/commands/intake/confirm.js'
import { INTAKE_MOVE_EVENT } from '../../../src/commands/intake/move.js'
import { BACKFILL_SOURCE } from '../../bus/backfill-source.js'
import { BACKFILL_ACTOR } from '../../bus/backfill.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { CARD_STARTED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { slotsOf } from '../../bus/scheduler.js'
import { readJournalFile, runTaskStart } from '../../ghosts/task-start.js'
import { DEFAULT_WORKTREE_HOME, WORKTREE_HOME_VARIABLE, worktreeHome } from '../../ghosts/worktree-home.js'

const SESSION = '0d538601-aaaa-bbbb-cccc-1234567890ab'
const NOW = new Date('2026-10-02T08:00:00.000Z')
const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']

function card(id: number, bracket = 'implement/ghosts/S/cheap/auto'): string {
  return `#${id} task-${id} [${bracket}] · depends — · blocks —`
}

const W1_CARD = '#101 task-card [implement/ghosts/M/cheap/owner] · depends #86 · blocks #124 the board card'
const ADMITTED_TS = '2026-10-01T08:00:00.000Z'
const ADMITTED = [101, 2, 3, 4, 5, 8, 9, 21, 31, 32, 41, 42, 51, 52]

interface World {
  root: string
  repo: string
  handoff: string
  journal: string
  bus: string
}

function admit(bus: string, ids: readonly number[]): void {
  const db = openBus(bus)
  for (const id of ids)
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: 'reducer', cardId: id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:intake:${id}`, payload: { lane: 'lane-1', depends: [], decision: null, contour: null, admission: `intake:${id}` }, legacy: false })
  db.close()
}

function recordIntake(bus: string, id: number, line: string): void {
  const db = openBus(bus)
  appendEvent(db, { ts: ADMITTED_TS, type: INTAKE_EVENT, actor: 'journal', cardId: id, pr: null, head: null, dedupeKey: `intake:${id}`, payload: { event: INTAKE_EVENT, task: String(id), card: line }, legacy: true })
  db.close()
}

function busEvents(world: World, type: string): { actor: string, cardId: number, payload: Record<string, unknown> }[] {
  const db = openBus(world.bus)
  const rows = db.prepare('SELECT actor, card_id, payload FROM events WHERE type = ? ORDER BY id').all(type) as { actor: string, card_id: number, payload: string }[]
  db.close()
  return rows.map(row => ({ actor: row.actor, cardId: row.card_id, payload: JSON.parse(row.payload) as Record<string, unknown> }))
}

function starts(world: World): Record<string, unknown>[] {
  return busEvents(world, CARD_STARTED).map(event => event.payload)
}

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-start-world-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  const handoff = path.join(root, 'handoff')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  const bus = path.join(root, 'bus', 'bus.db')
  admit(bus, ADMITTED)
  return { root, repo, handoff, journal: path.join(handoff, 'ghosts.jsonl'), bus }
}

function depsOf(world: World, session: string | null = SESSION, installs: [string, string[]][] = []): TaskStartDeps {
  return {
    cwd: world.repo,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    install: (cwd, args) => {
      installs.push([cwd, args])
    },
    exists: existsSync,
    bus: world.bus,
    now: () => NOW,
    session: session ?? undefined,
    handoffDir: world.handoff,
    readJournal: () => `${JSON.stringify({ event: 'merge', task: '86', by: 'E1i', commit: 'c0ffee', ts: ADMITTED_TS })}\n`,
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('task:start reads the admission from the bus and writes the start to it', () => {
  it('a card with card.admitted in the bus and no intake line in the journal starts', () => {
    const world = newWorld()
    const deps = { ...depsOf(world), readJournal: () => null }
    const result = runTaskStart(['feat/a1', '--card', card(41)], deps)
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ admission: { by: 'bus', event: `${CARD_ADMITTED}:intake:41`, admitted: ADMITTED_TS } }])
  })

  it('a card admitted in the bus from an intake line for the same card starts, admitted by the bus', () => {
    const world = newWorld()
    recordIntake(world.bus, 79, card(79))
    admit(world.bus, [79])
    expect(runTaskStart(['feat/a7', '--card', card(79)], depsOf(world)).exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ admission: { by: 'bus', event: `${CARD_ADMITTED}:intake:79` } }])
  })

  it('a card whose line changed after its card.admitted is refused naming the admitted card', () => {
    const world = newWorld()
    const admitted = card(81, 'implement/ghosts/M/cheap/auto')
    recordIntake(world.bus, 81, admitted)
    admit(world.bus, [81])
    const result = runTaskStart(['feat/a8', '--card', card(81)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] card #81 was admitted in the bus ${world.bus} as a different card (${admitted}) by ${CARD_ADMITTED}:intake:81: admit the current card through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(starts(world)).toEqual([])
  })

  it('a card moved after its admission whose line then changed is refused naming the admitted card', () => {
    const world = newWorld()
    const admitted = card(83, 'implement/ghosts/M/cheap/auto')
    recordIntake(world.bus, 83, admitted)
    admit(world.bus, [83])
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: INTAKE_MOVE_EVENT, actor: 'journal', cardId: 83, pr: null, head: null, dedupeKey: 'move:83', payload: { event: INTAKE_MOVE_EVENT, task: '83', from: '/parking/lane-1', to: '/parking/lane-2' }, legacy: true })
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: 'reducer', cardId: 83, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:move:83`, payload: { lane: 'lane-2', depends: [], decision: null, contour: null, admission: 'move:83' }, legacy: false })
    db.close()
    const result = runTaskStart(['feat/a9', '--card', card(83)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] card #83 was admitted in the bus ${world.bus} as a different card (${admitted}) by ${CARD_ADMITTED}:move:83: admit the current card through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(starts(world)).toEqual([])
  })

  it('a card re-admitted with a changed line starts on the latest admission, and its old line is refused naming the new one', () => {
    const world = newWorld()
    const first = card(85, 'implement/ghosts/M/cheap/auto')
    const second = card(85)
    recordIntake(world.bus, 85, first)
    admit(world.bus, [85])
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: INTAKE_EVENT, actor: 'journal', cardId: 85, pr: null, head: null, dedupeKey: 'intake:85:again', payload: { event: INTAKE_EVENT, task: '85', card: second }, legacy: true })
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: 'reducer', cardId: 85, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:intake:85:again`, payload: { lane: 'lane-1', depends: [], decision: null, contour: null, admission: 'intake:85:again' }, legacy: false })
    db.close()
    const old = runTaskStart(['feat/a10', '--card', first], depsOf(world))
    expect(old.exitCode).toBe(1)
    expect(old.stderr).toEqual([`[task:start] card #85 was admitted in the bus ${world.bus} as a different card (${second}) by ${CARD_ADMITTED}:intake:85:again: admit the current card through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(runTaskStart(['feat/a10', '--card', second], depsOf(world)).exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ admission: { by: 'bus', event: `${CARD_ADMITTED}:intake:85:again` } }])
  })

  it('task:start without card.admitted and without an intake line in the journal is refused', () => {
    const world = newWorld()
    const result = runTaskStart(['feat/a2', '--card', card(77)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] card #77 has no ${CARD_ADMITTED} in the bus ${world.bus}: it was not admitted; admit it through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(existsSync(path.join(world.root, 'mc-77'))).toBe(false)
    expect(starts(world)).toEqual([])
  })

  it('a card whose only card.admitted is a backfill is refused as not admitted', () => {
    const world = newWorld()
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: BACKFILL_ACTOR, cardId: 78, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${BACKFILL_SOURCE}:78`, payload: { card: card(78), lane: 'lane-1', source: BACKFILL_SOURCE, text: card(78), textSha: 'f'.repeat(64), bodyMatchesAdmission: false, textVerified: false }, legacy: false })
    db.close()
    const result = runTaskStart(['feat/a11', '--card', card(78)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] card #78 has no ${CARD_ADMITTED} in the bus ${world.bus}: it was not admitted; admit it through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(starts(world)).toEqual([])
  })

  it('a backfill after a real admission leaves the start on the real admission', () => {
    const world = newWorld()
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: BACKFILL_ACTOR, cardId: 101, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${BACKFILL_SOURCE}:101`, payload: { card: W1_CARD, lane: 'lane-1', source: BACKFILL_SOURCE, text: W1_CARD, textSha: 'f'.repeat(64), bodyMatchesAdmission: false, textVerified: false }, legacy: false })
    db.close()
    expect(runTaskStart(['feat/a12', '--card', W1_CARD], depsOf(world)).exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ admission: { by: 'bus', event: `${CARD_ADMITTED}:intake:101` } }])
  })

  it('a card with no card.admitted is refused even when the journal holds an intake line for the same card', () => {
    const world = newWorld()
    const journal = `${JSON.stringify({ event: 'intake', task: '77', card: card(77), confirmation: 'c-77', corrections: [], ts: ADMITTED_TS })}\n`
    const result = runTaskStart(['feat/a7', '--card', card(77)], { ...depsOf(world), readJournal: () => journal })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] card #77 has no ${CARD_ADMITTED} in the bus ${world.bus}: it was not admitted; admit it through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(starts(world)).toEqual([])
  })

  it('a card admitted through the intake port starts on the card its own payload carries, and another line is refused', () => {
    const world = newWorld()
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: 87, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:87:port`, payload: { card: card(87), lane: null, depends: [], decision: 'auto', contour: 'cheap' }, legacy: false })
    db.close()
    const other = card(87, 'implement/ghosts/M/cheap/auto')
    expect(runTaskStart(['feat/a9', '--card', other], depsOf(world)).stderr).toEqual([`[task:start] card #87 was admitted in the bus ${world.bus} as a different card (${card(87)}) by ${CARD_ADMITTED}:87:port: admit the current card through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(runTaskStart(['feat/a9', '--card', card(87)], depsOf(world)).exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ admission: { by: 'bus', event: `${CARD_ADMITTED}:87:port`, admitted: ADMITTED_TS } }])
  })

  it('a card with no card.admitted starts under --without-intake and records the waiver', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/a3', '--card', card(78), '--without-intake', 'the owner said so'], depsOf(world)).exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ admission: { by: 'waiver', flag: '--without-intake', reason: 'the owner said so' } }])
  })

  it('task:start writes card.started to the bus and nothing to the journal', () => {
    const world = newWorld()
    const result = runTaskStart(['feat/a4', '--card', card(42)], depsOf(world))
    const worktree = path.join(world.root, 'mc-42')
    expect(result.exitCode).toBe(0)
    expect(busEvents(world, CARD_STARTED)).toMatchObject([{ actor: `worker:start:${SESSION}`, cardId: 42, payload: { session: SESSION, worktree, branch: 'feat/a4' } }])
    expect(existsSync(world.journal)).toBe(false)
  })

  it('a start by hand with no session is written by worker:start:by-hand', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/a5', '--card', card(42)], depsOf(world, null)).exitCode).toBe(0)
    expect(busEvents(world, CARD_STARTED).map(event => event.actor)).toEqual(['worker:start:by-hand'])
  })

  it('a card whose launch the launch worker holds gets no card.started from task:start: the launch worker writes it', () => {
    const world = newWorld()
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: 'task.leased', actor: 'worker:launch:s1', cardId: 41, pr: null, head: null, dedupeKey: 'task.leased:launch:41', payload: {}, legacy: false })
    const leasedBy = (db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get('task.leased:launch:41') as { id: number }).id
    db.prepare('INSERT INTO tasks (task_key, queue, card_id, state, event_id) VALUES (?, ?, ?, ?, ?)').run('launch:41', 'launch', 41, 'leased', leasedBy)
    db.close()
    const result = runTaskStart(['feat/a6', '--card', card(41)], depsOf(world))
    expect(result.exitCode).toBe(0)
    expect(starts(world)).toEqual([])
    expect(result.stdout[3]).toBe(`ACTION   | task:start feat/a6 #41: cut ${path.join(world.root, 'mc-41')} from origin/main; card.started is the launch worker's, which holds the launch of #41`)
  })
})

describe('task:start refuses while the window holds its limit of open pull requests', () => {
  function openPr(world: World, pr: number, cardId: number, started: Record<string, unknown> = {}): void {
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_STARTED, actor: `worker:start:${SESSION}`, cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}`, payload: { path: 'cheap', ...started }, legacy: false })
    const eventId = (db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id
    db.prepare('INSERT INTO prs (pr, card_id, state, event_id) VALUES (?, ?, ?, ?)').run(pr, cardId, 'open', eventId)
    db.close()
  }

  it('with three open pull requests of the window and a limit of three, task:start refuses naming them and cuts no branch', () => {
    const world = newWorld()
    openPr(world, 901, 2)
    openPr(world, 902, 3)
    openPr(world, 903, 4)
    const before = starts(world).length
    const result = runTaskStart(['feat/wip', '--card', card(42)], { ...depsOf(world), windowLimit: () => 3 })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual(['[task:start] the window holds 3 open pull requests (PR #901, PR #902, PR #903), at its limit of 3 from CONSTRUCT_BUS_SLOTS_REVIEW: move one to its merge or close before starting #42; nothing written'])
    expect(git(world.repo, ['branch', '--list', 'feat/wip'])).toBe('')
    expect(existsSync(path.join(world.root, 'mc-42'))).toBe(false)
    expect(starts(world)).toHaveLength(before)
  })

  it('an unreadable slot count refuses the start naming the variable and cuts no branch, instead of throwing', () => {
    const world = newWorld()
    const before = starts(world).length
    const result = runTaskStart(['feat/wip', '--card', card(42)], { ...depsOf(world), windowLimit: () => slotsOf('review', { CONSTRUCT_BUS_SLOTS_REVIEW: 'three' }) })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual(['[task:start] the window limit cannot be read: CONSTRUCT_BUS_SLOTS_REVIEW is not a positive integer: three; nothing written'])
    expect(git(world.repo, ['branch', '--list', 'feat/wip'])).toBe('')
    expect(starts(world)).toHaveLength(before)
  })

  it('a pull request a shift started and a closed one are not the window\'s, so two of its own under a limit of three start the card', () => {
    const world = newWorld()
    openPr(world, 901, 2)
    openPr(world, 902, 3)
    openPr(world, 903, 4, { shift: 'shift-1' })
    openPr(world, 904, 5)
    const db = openBus(world.bus)
    db.prepare('UPDATE prs SET state = ? WHERE pr = ?').run('closed', 904)
    db.close()
    expect(runTaskStart(['feat/wip', '--card', card(42)], { ...depsOf(world), windowLimit: () => 3 }).exitCode).toBe(0)
  })
})

describe('w1: task:start cuts the tree and writes the start', () => {
  it('w1: cuts ../mc-<id> on the branch from origin/main and writes one card.started with worktree, branch, session and the card', () => {
    const world = newWorld()
    const line = W1_CARD
    const result = runTaskStart(['feat/t1', '--card', line], depsOf(world))
    const worktree = path.join(world.root, 'mc-101')
    expect(result.exitCode).toBe(0)
    expect(result.worktree).toBe(worktree)
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat/t1')
    expect(starts(world).map(({ entry: _, ...start }) => start)).toEqual([{
      path: 'cheap',
      started: NOW.toISOString(),
      session: SESSION,
      worktree,
      branch: 'feat/t1',
      card: { id: 101, name: 'task-card', kind: 'implement', milestone: 'ghosts', size: 'M', contour: 'cheap', decision: 'owner', depends: [86], blocks: [124], line },
      admission: { by: 'bus', event: `${CARD_ADMITTED}:intake:101`, admitted: ADMITTED_TS },
    }])
  })

  it('task:start fetches origin main over https through the proxy', () => {
    const world = newWorld()
    const calls: string[][] = []
    const deps = depsOf(world)
    const result = runTaskStart(['feat/s1', '--card', card(41)], { ...deps, git: (cwd, args) => {
      calls.push(args)
      return deps.git(cwd, args)
    } })
    expect(result.exitCode).toBe(0)
    const fetch = calls.find(args => args.includes('fetch'))!
    expect(fetch.slice(-3)).toEqual(['fetch', 'origin', 'main'])
    git(world.repo, ['remote', 'set-url', 'origin', 'git@github.com:E1i/mikoshi-construct.git'])
    expect(git(world.repo, [...fetch.slice(0, -3), 'remote', 'get-url', 'origin']).trim()).toBe('https://github.com/E1i/mikoshi-construct.git')
    git(world.repo, ['remote', 'set-url', 'origin', 'ssh://git@github.com/E1i/mikoshi-construct.git'])
    expect(git(world.repo, [...fetch.slice(0, -3), 'remote', 'get-url', 'origin']).trim()).toBe('https://github.com/E1i/mikoshi-construct.git')
  })

  it('cuts a new worktree under the worktree home', () => {
    const world = newWorld()
    const home = path.join(world.root, 'home', 'worktrees')
    const result = runTaskStart(['feat/h1', '--card', card(41)], { ...depsOf(world), worktreeHome: home })
    const worktree = path.join(home, 'mc-41')
    expect(result.exitCode).toBe(0)
    expect(result.worktree).toBe(worktree)
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat/h1')
    expect(existsSync(path.join(world.root, 'mc-41'))).toBe(false)
    expect(starts(world)).toMatchObject([{ worktree }])
  })

  it('reads the worktree home from its environment variable, else ~/.construct/worktrees', () => {
    expect(worktreeHome({ [WORKTREE_HOME_VARIABLE]: '/elsewhere/trees' })).toBe('/elsewhere/trees')
    expect(worktreeHome({})).toBe(path.join(homedir(), '.construct', 'worktrees'))
    expect(worktreeHome({ [WORKTREE_HOME_VARIABLE]: '' })).toBe(DEFAULT_WORKTREE_HOME)
  })

  it('the card.started names the shift that started the card', () => {
    const world = newWorld()
    const shift = path.join(world.root, 'shift')
    expect(runTaskStart(['feat/s1', '--card', card(41)], { ...depsOf(world), shift }).exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ shift }])
  })

  it('a start by hand writes no shift field', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/s2', '--card', card(42)], depsOf(world)).exitCode).toBe(0)
    expect(starts(world)[0]).not.toHaveProperty('shift')
  })

  it('w8: prints CONTRACT, EXPECT, ACTION and RESULT from the card and the start it wrote', () => {
    const world = newWorld()
    const result = runTaskStart(['feat/t8', '--card', card(8, 'implement/ghosts/M/cheap/owner')], depsOf(world))
    const worktree = path.join(world.root, 'mc-8')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toEqual([
      expect.stringMatching(/^-{4} task:start #8 task-8 -+$/),
      'CONTRACT | implement · cheap · owner · touches not recorded on the card: no parking file for #8 · law not recorded on the card',
      'EXPECT   | expect not recorded on the start line: its session is the window\'s CLAUDE_CODE_SESSION_ID, shared by every task the window runs, so no session is this task\'s alone',
      `ACTION   | task:start feat/t8 #8: cut ${worktree} from origin/main; card.started written to ${world.bus}`,
      'RESULT   | accepted · not started',
    ])
  })

  it('w8: writes the entry card inside the card.started, in the four fields the card printed', () => {
    const world = newWorld()
    const result = runTaskStart(['feat/t9', '--card', card(9, 'implement/ghosts/M/cheap/owner')], depsOf(world))
    const worktree = path.join(world.root, 'mc-9')
    const entry = starts(world)[0]!.entry as Record<string, string>
    expect(entry).toEqual({
      schema: 2,
      CONTRACT: 'implement · cheap · owner · touches not recorded on the card: no parking file for #9 · law not recorded on the card',
      EXPECT: 'expect not recorded on the start line: its session is the window\'s CLAUDE_CODE_SESSION_ID, shared by every task the window runs, so no session is this task\'s alone',
      ACTION: `task:start feat/t9 #9: cut ${worktree} from origin/main; card.started written to ${world.bus}`,
      RESULT: 'accepted · not started',
    })
    expect(result.stdout.slice(1).map(row => row.replace(/^\w+\s+\| /, ''))).toEqual(['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'].map(field => entry[field]))
  })

  it('w8: a field with no data is named in the entry card: no session names it in ACTION', () => {
    const world = newWorld()
    const result = runTaskStart(['--card', card(2), 'feat/t2'], depsOf(world, null))
    expect(result.stdout[3]).toContain('CLAUDE_CODE_SESSION_ID is not set, the board will show WINDOW UNKNOWN (no session)')
    expect(result.stdout[4]).toBe('RESULT   | accepted · not started')
  })

  it('w1: writes a start without session and says the board will show WINDOW UNKNOWN when no session is set', () => {
    const world = newWorld()
    const result = runTaskStart(['--card', card(2), 'feat/t2'], depsOf(world, null))
    expect(result.exitCode).toBe(0)
    expect(starts(world)[0]).not.toHaveProperty('session')
    expect(result.stdout.join('\n')).toContain('WINDOW UNKNOWN (no session)')
  })

  it('w1: refuses an existing tree path and writes nothing', () => {
    const world = newWorld()
    mkdirSync(path.join(world.root, 'mc-3'))
    const result = runTaskStart(['feat/t3', '--card', card(3)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] .*mc-3 already exists/)
    expect(starts(world)).toEqual([])
    expect(git(world.repo, ['branch', '--list', 'feat/t3']).trim()).toBe('')
  })

  it('w1: refuses an existing local branch and writes nothing', () => {
    const world = newWorld()
    git(world.repo, ['branch', 'feat/t4'])
    const result = runTaskStart(['feat/t4', '--card', card(4)], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] branch feat\/t4 already exists/)
    expect(existsSync(path.join(world.root, 'mc-4'))).toBe(false)
    expect(starts(world)).toEqual([])
  })

  it('w1: refuses a --card with no value or without a branch', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/x', '--card'], depsOf(world)).stderr[0]).toMatch(/^\[task:start\] usage:/)
    expect(runTaskStart(['--card', card(5)], depsOf(world)).stderr[0]).toMatch(/^\[task:start\] usage:/)
  })
})

describe('w3: task:start installs the dependencies in the new tree', () => {
  it('w3: runs pnpm install --frozen-lockfile --prefer-offline once, in the cut tree, before the start', () => {
    const world = newWorld()
    const installs: [string, string[]][] = []
    const result = runTaskStart(['feat/i1', '--card', card(31)], depsOf(world, SESSION, installs))
    expect(result.exitCode).toBe(0)
    expect(installs).toEqual([[path.join(world.root, 'mc-31'), INSTALL_ARGS]])
    expect(starts(world)).toHaveLength(1)
  })

  it('w3: a failed install refuses with its first line, writes no start, and removes the tree and the branch so a retry starts clean', () => {
    const world = newWorld()
    const deps: TaskStartDeps = {
      ...depsOf(world),
      install: () => {
        throw new Error('ERR_PNPM_NO_OFFLINE_TARBALL picocolors\nmore')
      },
    }
    const worktree = path.join(world.root, 'mc-32')
    const result = runTaskStart(['feat/i2', '--card', card(32)], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] pnpm install --frozen-lockfile --prefer-offline failed in ${worktree}: ERR_PNPM_NO_OFFLINE_TARBALL picocolors; the tree and branch feat/i2 were removed; nothing written`])
    expect(starts(world)).toEqual([])
    expect(existsSync(worktree)).toBe(false)
    expect(git(world.repo, ['branch', '--list', 'feat/i2']).trim()).toBe('')
    expect(runTaskStart(['feat/i2', '--card', card(32)], depsOf(world)).exitCode).toBe(0)
  })
})

describe('w2: task:start refuses a card of the wrong form, and the old call', () => {
  it.each([
    ['an unknown milestone', card(11, 'implement/moon/S/cheap/auto'), `milestone 'moon' is not one of`],
    ['kind probe with decision owner', card(12, 'probe/ghosts/S/cheap/owner'), 'kind probe takes decision none, not owner'],
    ['a bad size', card(13, 'implement/ghosts/XL/cheap/auto'), `size 'XL' is not one of XS, S, M, L`],
    ['no · depends', '#14 x [implement/ghosts/S/cheap/auto] · blocks —', `'· depends <#id …|—>' must follow`],
  ])('w2: refuses %s with the reason, cuts no tree and writes no line', (_, line, reason) => {
    const world = newWorld()
    const result = runTaskStart(['feat/bad', '--card', line], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('[task:start] card refused: ')
    expect(result.stderr[0]).toContain(reason)
    expect(readdirSync(world.root).filter(name => name.startsWith('mc-'))).toEqual([])
    expect(starts(world)).toEqual([])
  })

  it('w2: refuses the old task:start <id> <branch> and names the new form', () => {
    const world = newWorld()
    const result = runTaskStart(['t1', 'feat/t1'], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] a task starts from its card now: usage: pnpm task:start <branch> --card "<card>" [--parking <dir>] [--without-intake "<reason>"]; the id is the card's #<id>`])
    expect(existsSync(path.join(world.root, 'mc-t1'))).toBe(false)
  })
})

describe('the start path follows the card contour', () => {
  it('writes path ladder for a ladder card', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/l', '--card', card(21, 'implement/ghosts/L/ladder/owner')], depsOf(world)).exitCode).toBe(0)
    expect(starts(world)).toMatchObject([{ path: 'ladder' }])
  })
})

describe('task:start --adopt takes an existing tree instead of cutting one', () => {
  function released(world: World, id: number, branch: string): string {
    const tree = path.join(world.root, `mc-${id}`)
    git(world.repo, ['worktree', 'add', '-q', '-b', branch, tree, 'origin/main'])
    return tree
  }

  function recording(world: World, calls: string[][], installs: [string, string[]][] = []): TaskStartDeps {
    const deps = depsOf(world, SESSION, installs)
    return { ...deps, git: (cwd, args) => {
      calls.push(args)
      return deps.git(cwd, args)
    } }
  }

  it('adopts an existing tree: the card.started and its entry say adopts <tree>, and nothing is cut or installed', () => {
    const world = newWorld()
    const tree = released(world, 51, 'feat/a1')
    const calls: string[][] = []
    const installs: [string, string[]][] = []
    const result = runTaskStart(['feat/a1', '--card', card(51), '--adopt', tree], recording(world, calls, installs))
    expect(result.exitCode).toBe(0)
    expect(result.worktree).toBe(tree)
    expect(installs).toEqual([])
    expect(calls.map(args => args[0])).toEqual(['rev-parse', 'rev-parse'])
    expect(starts(world)).toMatchObject([{ worktree: tree, adopts: tree, branch: 'feat/a1', admission: { by: 'bus' }, entry: { ACTION: `task:start feat/a1 #51: adopts ${tree}; card.started written to ${world.bus}` } }])
    expect(result.stdout.join('\n')).toContain(`adopts ${tree}`)
    expect(result.stdout.join('\n')).not.toContain('from origin/main')
  })

  it('refuses to adopt a tree whose HEAD is not on the card\'s branch, and writes nothing', () => {
    const world = newWorld()
    const tree = released(world, 52, 'feat/other')
    const result = runTaskStart(['feat/a2', '--card', card(52), '--adopt', tree], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] cannot adopt ${tree}: its HEAD is on feat/other, not on the card's branch feat/a2; nothing written`])
    expect(starts(world)).toEqual([])
  })

  it('refuses to adopt a subdirectory of a tree, and writes nothing', () => {
    const world = newWorld()
    const tree = released(world, 51, 'feat/a6')
    const inside = path.join(tree, 'sub')
    mkdirSync(inside)
    const result = runTaskStart(['feat/a6', '--card', card(51), '--adopt', inside], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] cannot adopt ${inside}: it is not the top of a tree, ${tree} is; nothing written`])
    expect(starts(world)).toEqual([])
  })

  it('refuses to adopt a tree of another repository on the same branch, and writes nothing', () => {
    const world = newWorld()
    const foreign = path.join(world.root, 'foreign')
    git(world.root, ['clone', '-q', path.join(world.root, 'origin.git'), foreign])
    git(foreign, ['checkout', '-q', '-b', 'feat/a7'])
    const result = runTaskStart(['feat/a7', '--card', card(51), '--adopt', foreign], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] cannot adopt ${foreign}: it belongs to the repository at ${path.join(foreign, '.git')}, not to ${path.join(world.repo, '.git')}; nothing written`])
    expect(starts(world)).toEqual([])
  })

  it('refuses to adopt a path that is not a git tree, and writes nothing', () => {
    const world = newWorld()
    const tree = path.join(world.root, 'mc-51')
    mkdirSync(tree)
    const result = runTaskStart(['feat/a3', '--card', card(51), '--adopt', tree], { ...depsOf(world), cwd: world.root })
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] cannot adopt .*mc-51: it is not a git tree/)
    expect(starts(world)).toEqual([])
  })

  it('refuses to adopt for a card the bus did not admit, before touching git, and writes nothing', () => {
    const world = newWorld()
    const tree = released(world, 53, 'feat/a4')
    const calls: string[][] = []
    const result = runTaskStart(['feat/a4', '--card', card(53), '--adopt', tree], recording(world, calls))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] card #53 has no card\.admitted in the bus/)
    expect(calls).toEqual([])
    expect(starts(world)).toEqual([])
  })

  it('refuses --adopt with no tree with the usage line that names --adopt <tree>', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/a5', '--card', card(51), '--adopt'], depsOf(world)).stderr).toEqual([`[task:start] usage: pnpm task:start <branch> --card "<card>" --adopt <tree> [--parking <dir>] [--without-intake "<reason>"]`])
  })
})

describe('the card.started carries the card who and risk read from the card file at start', () => {
  const RISK = 'R2 — high: a contract or a recorded shape that others read changes; a review reads it — the factory mechanism: scripts/ghosts/task-start.ts'

  function parked(world: World, line: string, body: string, who = 'shift'): TaskStartDeps {
    const dir = path.join(world.root, 'parking')
    mkdirSync(dir, { recursive: true })
    const id = /^#(\d+)/.exec(line)![1]
    writeFileSync(path.join(dir, `${id}.md`), `card: ${line}\nbranch: feat/p\ntouches: a.ts\ncontinue: stop\nwho: ${who}\n\n${body}\n`)
    return { ...depsOf(world), parking: { dir, read: file => existsSync(file) ? readFileSync(file, 'utf8') : null } }
  }

  it('the card.started carries the card who and risk as written', () => {
    const world = newWorld()
    const deps = parked(world, card(41), `do it\n\nrisk: ${RISK}`, 'window')
    expect(runTaskStart(['feat/p1', '--card', card(41)], deps, { CONTRACT: 'C', EXPECT: 'E' }).exitCode).toBe(0)
    const line = starts(world)[0]!
    expect(line.who).toBe('window')
    expect(line.risk).toEqual({ level: 'R2', text: RISK })
  })

  it('a card without a risk line gets no risk field', () => {
    const world = newWorld()
    const deps = parked(world, card(42), 'do it, size M and contour cheap')
    expect(runTaskStart(['feat/p2', '--card', card(42)], deps).exitCode).toBe(0)
    const line = starts(world)[0]!
    expect(line.who).toBe('shift')
    expect(line).not.toHaveProperty('risk')
  })

  it('a risk line with no known level keeps its text and gets no level', () => {
    const world = newWorld()
    const deps = parked(world, card(31), 'do it\nrisk: unclear')
    expect(runTaskStart(['feat/p3', '--card', card(31)], deps).exitCode).toBe(0)
    expect(starts(world)[0]!.risk).toEqual({ text: 'unclear' })
  })

  it('a start with no card file, or a card file for another card, gets neither field', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/p4', '--card', card(2)], depsOf(world)).exitCode).toBe(0)
    const other = parked(world, card(3, 'implement/ghosts/M/cheap/owner'), `do it\nrisk: ${RISK}`)
    expect(runTaskStart(['feat/p5', '--card', card(3)], other, { CONTRACT: 'C', EXPECT: 'E' }).exitCode).toBe(0)
    expect(starts(world)).toHaveLength(2)
    for (const line of starts(world)) {
      expect(line).not.toHaveProperty('who')
      expect(line).not.toHaveProperty('risk')
    }
  })

  it('a parking path that exists but cannot be read names the read failure in the CONTRACT and starts', () => {
    const world = newWorld()
    const dir = path.join(world.root, 'parking')
    const unreadable = path.join(dir, '31.md')
    mkdirSync(unreadable, { recursive: true })
    const result = runTaskStart(['feat/p6', '--card', card(31)], { ...depsOf(world), parking: { dir, read: readJournalFile } })
    expect(result.exitCode).toBe(0)
    const reason = `touches not recorded on the card: ${unreadable} could not be read: EISDIR`
    expect(result.stdout.join('\n')).toContain(reason)
    expect(result.stdout.join('\n')).not.toContain('no parking file')
    const entry = starts(world)[0]!.entry as Record<string, string>
    expect(entry.CONTRACT).toContain(reason)
    expect(entry.CONTRACT).not.toContain('no parking file')
  })
})

describe('task:start checks the card file against the body its card.admitted carries', () => {
  interface Admission { sha?: (text: string) => string, touchesOnDisk?: string, movedAfter?: boolean }

  function parkedWithAdmission(world: World, id: number, admitted: string | null, onDisk: string, more: Admission = {}): TaskStartDeps {
    const { sha = bodySha, touchesOnDisk = 'a.ts', movedAfter = false } = more
    const dir = path.join(world.root, 'parking')
    mkdirSync(dir, { recursive: true })
    const text = (body: string, touches = 'a.ts'): string => `card: ${card(id)}\nbranch: feat/b\ntouches: ${touches}\ncontinue: stop\nwho: window\n\n${body}\n`
    writeFileSync(path.join(dir, `${id}.md`), text(onDisk, touchesOnDisk))
    const db = openBus(world.bus)
    appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${id}:body`, payload: { card: card(id), lane: null, depends: [], decision: 'auto', contour: 'cheap', ...(admitted === null ? {} : { bodySha: sha(text(admitted)) }) }, legacy: false })
    if (movedAfter)
      appendEvent(db, { ts: ADMITTED_TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${id}:moved`, payload: { card: card(id), lane: 'lane-1', depends: [], decision: 'auto', contour: 'cheap', moved: true }, legacy: false })
    db.close()
    return { ...depsOf(world), parking: { dir, read: file => existsSync(file) ? readFileSync(file, 'utf8') : null } }
  }

  it('a card admitted with a body, moved to a lane by an admission without one, then edited is refused', () => {
    const world = newWorld()
    const result = runTaskStart(['feat/b4', '--card', card(94)], parkedWithAdmission(world, 94, 'the admitted body', 'a body edited past intake', { movedAfter: true }))
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('the parking file of card #94 is not the body card.admitted:94:body admitted')
    expect(starts(world)).toEqual([])
  })

  it('a card file whose touches line changed since an admission of its body without touches starts', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/b5', '--card', card(95)], parkedWithAdmission(world, 95, 'the admitted body', 'the admitted body', { sha: bodyShaWithoutTouches, touchesOnDisk: 'b.ts' })).exitCode).toBe(0)
  })

  it('a card file edited past its admission is refused with nothing written', () => {
    const world = newWorld()
    const deps = parkedWithAdmission(world, 91, 'the admitted body', 'a body edited past intake')
    const result = runTaskStart(['feat/b1', '--card', card(91)], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toMatch(/^\[task:start\] the parking file of card #91 is not the body card\.admitted:91:body admitted \(bodySha [0-9a-f]{12}, the file [0-9a-f]{12}\): it was edited past intake; admit it again through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written$/)
    expect(starts(world)).toEqual([])
    expect(existsSync(path.join(world.root, 'mc-91'))).toBe(false)
    expect(runTaskStart(['feat/b1', '--card', card(91), '--without-intake', 'the owner said so'], deps).exitCode).toBe(0)
  })

  it('a card file holding the admitted body starts', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/b2', '--card', card(92)], parkedWithAdmission(world, 92, 'the admitted body', 'the admitted body')).exitCode).toBe(0)
  })

  it('an admission without a bodySha starts as before', () => {
    const world = newWorld()
    expect(runTaskStart(['feat/b3', '--card', card(93)], parkedWithAdmission(world, 93, null, 'any body')).exitCode).toBe(0)
  })
})
