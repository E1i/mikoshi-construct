import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import type { Role, SilentOwnerSession } from '../../../nodes/restart/role.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../../core/db.js'
import { signStampsSince } from '../../../core/events-query.js'
import { CARD_CLOSED, CARD_VERIFIED, PR_OPENED, REVIEW_RECORDED, ROLE_RETURNED, SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../../core/events.js'
import { LEASE_MS, leaseQueued } from '../../../core/lease.js'
import { WINDOW_ACTOR } from '../../../core/node.js'
import { keyOf, queueTask } from '../../../core/queue.js'
import { reduce } from '../../../core/reducer.js'
import { cardClosed, probeClosingCardIds } from '../../../nodes/close/close-executor.js'
import { leasedAt } from '../../../nodes/close/ended-card-trees.js'
import { pullRequestOfCard } from '../../../nodes/close/task-close.js'
import { lastWindowEnd, observeRoleStop, returnSilentRole, roleToOwner, silentOwnerSession } from '../../../nodes/restart/role.js'
import { earlierChangesRounds } from '../../../nodes/review/review-executor.js'
import { sessionsUnderLiveLeases } from '../../../nodes/review/review-worker.js'
import { busProjections } from '../../../supervisor/composition.js'
import { recordWindowHeartbeat } from '../../../window/window-heartbeat.js'
import { requestFromWindow } from '../../../window/window-requests.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const FILES_OF_MODULE: Record<string, readonly string[]> = {
  'node-close': ['scripts/nodes/close/close-executor.ts', 'scripts/nodes/close/task-close.ts', 'scripts/nodes/close/ended-card-trees.ts', 'scripts/nodes/close/task-merged.ts'],
  'node-review': ['scripts/nodes/review/review-executor.ts', 'scripts/nodes/review/divergence-alarm.ts', 'scripts/nodes/review/review-worker.ts'],
  'node-restart': ['scripts/nodes/restart/role.ts', 'scripts/nodes/restart/restart-executor.ts'],
}
const READERS = Object.values(FILES_OF_MODULE).flat()

async function ruleWithoutExceptions(): Promise<ESLint> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, READERS[0]!)) as { languageOptions: { parser: Linter.Parser } }
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.{ts,mts,cts,js,mjs,cjs}'], languageOptions: { parser: config.languageOptions.parser, sourceType: 'module' }, linterOptions: { reportUnusedDisableDirectives: 'off' } },
      ...FOREIGN_TABLE_SQL_POLICY.map(block => ({ ...block, ignores: (block.ignores ?? []).filter(ignored => !EXCEPTED.includes(ignored)) })),
    ],
  })
}

async function foreignTablesOf(files: readonly string[]): Promise<Record<string, string[]>> {
  const results = await (await ruleWithoutExceptions()).lintFiles([...files])
  return Object.fromEntries(results.map(result => [
    path.relative(REPO_ROOT, result.filePath),
    result.messages.filter(message => message.ruleId === RULE).map(message => `${NAMED_TABLE.exec(message.message)?.[1] ?? message.message}:${message.line}`),
  ]))
}

describe('the close, review and restart nodes read the tables of other owners only through their contracts', () => {
  it('each file belongs to its node and none stays on the excepted list', () => {
    for (const [module, files] of Object.entries(FILES_OF_MODULE)) {
      for (const file of files)
        expect(MODULE_FILES[module]).toContain(file)
    }
    expect(EXCEPTED.filter(file => READERS.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in any of them', async () => {
    expect(await foreignTablesOf(READERS)).toEqual(Object.fromEntries(READERS.map(file => [file, []])))
  }, LINT_MS)
})

const SILENT_OWNER_SESSION_AT_BASE = `
  SELECT roles.role, roles.handoff, roles.event_id, max(signs.ts) AS last_sign FROM roles
  JOIN events AS signs ON signs.id > roles.event_id AND (signs.type = ? OR signs.actor LIKE ? || '%')
  WHERE roles.state = 'owner'
  GROUP BY roles.role HAVING max(signs.ts) < ?
  ORDER BY roles.role LIMIT 1
`
const OWNED_ROLES = `SELECT role, handoff, event_id FROM roles WHERE state = 'owner' ORDER BY role`
const WINDOW_SIGNS = { types: [WINDOW_HEARTBEAT], actorPrefix: WINDOW_ACTOR }

describe('a silent owner session is judged from the signs past the event of the role as values', () => {
  const HANDOFF = '/handoff/miko.md'
  const START = Date.parse('2026-11-20T10:00:00.000Z')
  const at = (ms: number): string => new Date(START + ms).toISOString()
  const ACTOR = 'worker:restart:w'

  function atBase(db: DatabaseSync, silentSince: string): SilentOwnerSession | null {
    return (db.prepare(SILENT_OWNER_SESSION_AT_BASE).get(WINDOW_HEARTBEAT, WINDOW_ACTOR, silentSince) as SilentOwnerSession | undefined) ?? null
  }

  function fromValues(db: DatabaseSync, silentSince: string): SilentOwnerSession | null {
    const owned = db.prepare(OWNED_ROLES).all() as unknown as { role: Role, handoff: string, event_id: number }[]
    const signs = owned.length === 0 ? [] : signStampsSince(db, Math.min(...owned.map(row => row.event_id)), WINDOW_SIGNS)
    return silentOwnerSession(owned, signs, silentSince)
  }

  it('a sign at or before the event of the role does not count, a later one does', () => {
    const owned = [{ role: 'miko' as const, handoff: HANDOFF, event_id: 5 }]
    const signs = [{ id: 4, ts: at(9000) }, { id: 6, ts: at(1000) }]
    expect(silentOwnerSession(owned, signs, at(5000))).toEqual({ role: 'miko', handoff: HANDOFF, event_id: 5, last_sign: at(1000) })
    expect(silentOwnerSession(owned, signs.slice(0, 1), at(5000))).toBeNull()
    expect(silentOwnerSession(owned, signs, at(1000))).toBeNull()
  })

  it('the bus gives the stamps of the window signs past an event, and node-restart finds the session the base reading found', () => {
    const db = openBus(':memory:')
    expect(recordWindowHeartbeat(db, at(-10 * LEASE_MS), 'owner-session')).toBe(true)
    observeRoleStop(db, at(0), 'worker:miko:7', { role: 'miko', handoff: HANDOFF, status: 'CONTINUE', reason: 'context', raised: false })
    reduce(db, 'pending', busProjections())
    expect(roleToOwner(db, at(10), ACTOR)).toMatchObject({ role: 'miko' })
    reduce(db, 'pending', busProjections())
    const roleEvent = (db.prepare(OWNED_ROLES).get() as { event_id: number }).event_id
    expect(signStampsSince(db, roleEvent, WINDOW_SIGNS)).toEqual([])

    requestFromWindow(db, at(1000), 'owner-session', { kind: 'status' })
    for (const beat of [0.5, 1, 1.5].map(lease => at(1000 + lease * LEASE_MS)))
      expect(recordWindowHeartbeat(db, beat, 'owner-session')).toBe(true)
    const stamps = signStampsSince(db, roleEvent, WINDOW_SIGNS)
    expect(stamps.length).toBeGreaterThanOrEqual(4)
    expect(stamps.every(stamp => stamp.id > roleEvent)).toBe(true)

    const judged = [0, 1, 1.5, 2, 2.5, 2.6, 3, 4].map(lease => at(1000 + lease * LEASE_MS))
    for (const silentSince of judged)
      expect(fromValues(db, silentSince), silentSince).toEqual(atBase(db, silentSince))
    expect(judged.filter(silentSince => atBase(db, silentSince) !== null)).not.toEqual([])
    expect(judged.filter(silentSince => atBase(db, silentSince) === null)).not.toEqual([])

    const silent = atBase(db, at(1001 + 1.5 * LEASE_MS))!
    expect(returnSilentRole(db, at(1001 + 2.5 * LEASE_MS), ACTOR)).toEqual({ role: 'miko', handoff: HANDOFF, lastSign: silent.last_sign })
    db.close()
  })
})

describe('the readings the nodes now take from the owners keep their filters', () => {
  const TS = '2026-11-20T10:00:00.000Z'
  const ACTOR = 'worker:test:1'
  const CARD = 4242
  const HEAD = 'a'.repeat(40)
  const OTHER_HEAD = 'b'.repeat(40)
  const made: string[] = []

  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  function event(db: DatabaseSync, type: string, key: string, fields: { cardId?: number | null, pr?: number | null, head?: string | null, ts?: string, legacy?: boolean, payload?: object } = {}): void {
    appendEvent(db, { ts: fields.ts ?? TS, type, actor: ACTOR, cardId: fields.cardId ?? null, pr: fields.pr ?? null, head: fields.head ?? null, dedupeKey: key, payload: fields.payload ?? {}, legacy: fields.legacy ?? false })
  }

  it('a card closed only in the legacy journal is closed', () => {
    const db = openBus(':memory:')
    event(db, CARD_CLOSED, `${CARD_CLOSED}:legacy`, { cardId: CARD, legacy: true })
    expect(cardClosed(db, CARD)).toBe(true)
    expect(cardClosed(db, CARD + 1)).toBe(false)
    db.close()
  })

  it('a probe closes on a card.verified with no pull request, never on one that names a pull request', () => {
    const db = openBus(':memory:')
    event(db, CARD_VERIFIED, `${CARD_VERIFIED}:probe`, { cardId: CARD, payload: { report: 'reports/probe.md', verification: 'run' } })
    event(db, CARD_VERIFIED, `${CARD_VERIFIED}:pr`, { cardId: CARD + 1, pr: 77, payload: { report: 'reports/pr.md', verification: 'run' } })
    expect(probeClosingCardIds(db)).toEqual([CARD])
    db.close()
  })

  it('the pull request of a card is its newest one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-of-card-'))
    made.push(dir)
    const busPath = path.join(dir, 'bus.db')
    const db = openBus(busPath)
    for (const pr of [23, 11]) {
      event(db, PR_OPENED, `${PR_OPENED}:${CARD}:${pr}`, { cardId: CARD, pr, payload: { pr } })
      db.prepare('INSERT INTO prs (pr, card_id, state, event_id) VALUES (?, ?, \'open\', (SELECT max(id) FROM events))').run(pr, CARD)
    }
    db.close()
    expect(pullRequestOfCard(busPath, String(CARD))).toBe(23)
  })

  it('a lease holds a card only until its lease_until', () => {
    const db = openBus(':memory:')
    const task = { queue: 'close' as const, cardId: CARD }
    queueTask(db, TS, task)
    leaseQueued(db, TS, keyOf(task), 'worker:close:1')
    expect(leasedAt(db, CARD, TS)).toBe(true)
    expect(leasedAt(db, CARD, new Date(Date.parse(TS) + 10 * LEASE_MS).toISOString())).toBe(false)
    db.close()
  })

  it('a session under a live review lease is one whose beat carries the lease generation', () => {
    const db = openBus(':memory:')
    const task = { queue: 'review' as const, cardId: CARD, pr: 31, head: HEAD }
    queueTask(db, TS, task)
    const lease = leaseQueued(db, TS, keyOf(task), 'worker:review:1')!
    for (const [session, gen] of [['live', lease.leaseGen], ['stale', lease.leaseGen + 1]] as const)
      event(db, SESSION_HEARTBEAT, `${SESSION_HEARTBEAT}:${CARD}:${session}`, { cardId: CARD, payload: { session, task_key: lease.taskKey, lease_gen: gen } })
    expect(sessionsUnderLiveLeases(db)).toEqual(new Set(['live']))
    db.close()
  })

  it('the earlier changes rounds are the ones on other heads, newest first', () => {
    const db = openBus(':memory:')
    const PR = 41
    event(db, REVIEW_RECORDED, `${REVIEW_RECORDED}:other:1`, { cardId: CARD, pr: PR, head: OTHER_HEAD, payload: { head: OTHER_HEAD, verdict: 'changes', findings: ['older'] } })
    event(db, REVIEW_RECORDED, `${REVIEW_RECORDED}:other:2`, { cardId: CARD, pr: PR, head: OTHER_HEAD, payload: { head: OTHER_HEAD, verdict: 'pass', findings: [] } })
    event(db, REVIEW_RECORDED, `${REVIEW_RECORDED}:same:1`, { cardId: CARD, pr: PR, head: HEAD, payload: { head: HEAD, verdict: 'changes', findings: ['same head'] } })
    const task = { queue: 'review' as const, cardId: CARD, pr: PR, head: HEAD }
    queueTask(db, TS, task)
    const lease = leaseQueued(db, TS, keyOf(task), 'worker:review:1')!
    expect(earlierChangesRounds(db, lease)).toEqual([{ head: OTHER_HEAD, key: `${REVIEW_RECORDED}:other:1`, findings: ['older'] }])
    db.close()
  })

  it('the last end of the window is the latest role.returned that names an end', () => {
    const db = openBus(':memory:')
    const ends = ['2026-11-20T09:00:00.000Z', '2026-11-20T11:00:00.000Z', '2026-11-20T10:00:00.000Z']
    ends.forEach((ts, at) => event(db, ROLE_RETURNED, `${ROLE_RETURNED}:${at}`, { ts, payload: { role: 'miko', ended: 'close' } }))
    event(db, ROLE_RETURNED, `${ROLE_RETURNED}:no-end`, { ts: '2026-11-20T12:00:00.000Z', payload: { role: 'miko' } })
    expect(lastWindowEnd(db)).toBe('2026-11-20T11:00:00.000Z')
    db.close()
  })

  it('with two owner sessions the earlier one is judged from every sign past its own event', () => {
    const db = openBus(':memory:')
    const at = (ms: number): string => new Date(Date.parse(TS) + ms).toISOString()
    observeRoleStop(db, at(0), 'worker:operator:1', { role: 'operator', handoff: '/handoff/operator.md', status: 'CONTINUE', reason: 'context', raised: false })
    reduce(db, 'pending', busProjections())
    expect(roleToOwner(db, at(10), 'worker:restart:w')).toMatchObject({ role: 'operator' })
    reduce(db, 'pending', busProjections())
    expect(recordWindowHeartbeat(db, at(20), 'owner-session')).toBe(true)
    observeRoleStop(db, at(10 * LEASE_MS), 'worker:miko:1', { role: 'miko', handoff: '/handoff/miko.md', status: 'CONTINUE', reason: 'context', raised: false })
    reduce(db, 'pending', busProjections())
    expect(roleToOwner(db, at(10 * LEASE_MS + 10), 'worker:restart:w')).toMatchObject({ role: 'miko' })
    reduce(db, 'pending', busProjections())
    expect((db.prepare(OWNED_ROLES).all() as unknown[]).length).toBe(2)
    expect(returnSilentRole(db, at(12 * LEASE_MS), 'worker:restart:w')).toEqual({ role: 'operator', handoff: '/handoff/operator.md', lastSign: at(20) })
    db.close()
  })
})
