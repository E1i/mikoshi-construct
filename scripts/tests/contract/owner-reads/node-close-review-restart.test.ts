import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import type { Role, SilentOwnerSession } from '../../../nodes/restart/role.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../../core/db.js'
import { signStampsSince } from '../../../core/events-query.js'
import { WINDOW_HEARTBEAT } from '../../../core/events.js'
import { LEASE_MS } from '../../../core/lease.js'
import { reduce } from '../../../core/reducer.js'
import { observeRoleStop, returnSilentRole, roleToOwner, silentOwnerSession } from '../../../nodes/restart/role.js'
import { busProjections } from '../../../supervisor/composition.js'
import { recordWindowHeartbeat } from '../../../window/window-heartbeat.js'
import { requestFromWindow, WINDOW_ACTOR } from '../../../window/window-requests.js'

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
