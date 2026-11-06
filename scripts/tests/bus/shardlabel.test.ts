import type { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WINDOW_SHARD_VARIABLE } from '../../../src/commands/intake/confirm.js'
import { BUS_DB_VARIABLE } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, SHARD_ISSUED, SHARD_REVOKED } from '../../core/events.js'
import { windowShardOfRun } from '../../intake/intake.js'
import { windowShardEnded } from '../../policy/shards.js'

const INTAKE = fileURLToPath(new URL('../../intake/intake.ts', import.meta.url))
const SHARD = 'shard-window'
const HOUR_MS = 3_600_000
const SPAWNS_MS = 60_000
const SESSION = 'shardlabel-session'
const SESSION_VARIABLES = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR', 'CONSTRUCT_CARD', 'CONSTRUCT_BUS_RAISED', 'MIKO_WINDOW', 'MIKO_LOOP_PID', 'MIKO_EXIT_REQUEST', WINDOW_SHARD_VARIABLE]
const PERSON: NodeJS.ProcessEnv = {}
const TAB_WINDOW: NodeJS.ProcessEnv = { CLAUDE_CODE_SESSION_ID: SESSION, MIKO_WINDOW: 'tab' }
const LOOP_WINDOW: NodeJS.ProcessEnv = { CLAUDE_CODE_SESSION_ID: SESSION, MIKO_WINDOW: '1' }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench { root: string, repo: string, bus: string }

function bench(): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'shardlabel-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(path.join(root, 'draft.json'), JSON.stringify({ cards: [{ number: 12, name: 'first', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches: ['src/a.ts'], task: 'Change a.', witnesses: ['`true` exits 0'] }] }))
  writeFileSync(path.join(root, 'taken.txt'), '12\n')
  return { root, repo, bus: path.join(root, 'bus.db') }
}

function onBus<T>(w: Bench, read: (db: DatabaseSync) => T): T {
  const db = openBus(w.bus)
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

function issueShard(db: DatabaseSync, now: Date): void {
  const until = new Date(now.getTime() + HOUR_MS).toISOString()
  appendEvent(db, { ts: now.toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${SHARD}`, payload: { id: SHARD, by: 'owner', run: null, window: true, scope: 'merge', until }, legacy: false })
}

function sessionless(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.includes(name)))
}

function intake(w: Bench, session: NodeJS.ProcessEnv, ...flags: string[]): string {
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), INTAKE, '--draft', path.join(w.root, 'draft.json'), '--taken', path.join(w.root, 'taken.txt'), '--dir', w.repo, '--parking', path.join(w.root, 'parking'), '--plain', ...flags], { cwd: w.repo, encoding: 'utf8', env: { ...sessionless(), ...session, [BUS_DB_VARIABLE]: w.bus } })
  return `${run.stdout}${run.stderr}`
}

function confirmedRun(w: Bench, session: NodeJS.ProcessEnv): { confirmation: unknown, printed: string } {
  const token = intake(w, session).match(/--confirm (\S+)/)?.[1]
  expect(token).toBeDefined()
  const printed = intake(w, session, '--confirm', token!)
  const admitted = onBus(w, db => db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id DESC').get(CARD_ADMITTED) as { payload: string } | undefined)
  expect(admitted, printed).toBeDefined()
  return { confirmation: (JSON.parse(admitted!.payload) as { confirmation: unknown }).confirmation, printed }
}

describe('who confirmed an intake correction', () => {
  it('a window under an active shard confirms as window under shard', { timeout: SPAWNS_MS }, () => {
    const w = bench()
    const now = new Date()
    onBus(w, db => issueShard(db, now))
    expect(onBus(w, db => windowShardOfRun(db, LOOP_WINDOW, now))).toBe(SHARD)
    const { confirmation, printed } = confirmedRun(w, TAB_WINDOW)
    expect(confirmation).toBe(`window under shard ${SHARD}`)
    expect(printed).toContain(`window under shard ${SHARD}`)
    expect(printed).not.toContain('confirmed by a person')
  })

  it('a person at a terminal stays person under an active shard', { timeout: SPAWNS_MS }, () => {
    const w = bench()
    const now = new Date()
    onBus(w, db => issueShard(db, now))
    expect(onBus(w, db => windowShardOfRun(db, PERSON, now))).toBeNull()
    const { confirmation, printed } = confirmedRun(w, PERSON)
    expect(confirmation).toBe('person')
    expect(printed).toContain('confirmed by a person')
  })

  it('a window session with no active shard stays person', { timeout: SPAWNS_MS }, () => {
    const w = bench()
    const now = new Date()
    onBus(w, (db) => {
      issueShard(db, now)
      appendEvent(db, windowShardEnded(SHARD_REVOKED, 'owner', SHARD, now))
    })
    expect(onBus(w, db => windowShardOfRun(db, TAB_WINDOW, now))).toBeNull()
    expect(confirmedRun(w, TAB_WINDOW).confirmation).toBe('person')
  })

  it.each<[string, NodeJS.ProcessEnv]>([
    ['a card session', { ...TAB_WINDOW, CONSTRUCT_CARD: '1556' }],
    ['a headless session', { ...TAB_WINDOW, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
    ['a session the bus raised', { ...TAB_WINDOW, CONSTRUCT_BUS_RAISED: '1' }],
  ])('%s is no window and takes no shard', (_name, env) => {
    const w = bench()
    const now = new Date()
    onBus(w, db => issueShard(db, now))
    expect(onBus(w, db => windowShardOfRun(db, env, now))).toBeNull()
  })
})
