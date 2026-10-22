import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { LEASE_MS } from '../../bus/lease.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { replayDifferences } from '../../bus/report.js'
import { observeRoleStop, returnEndedRole, returnSilentRole, ROLES_PROJECTION, roleToOwner, WINDOW_ENDS } from '../../bus/role.js'
import { reduceProjection } from '../../bus/watermark.js'
import { recordWindowHeartbeat } from '../../bus/window-heartbeat.js'
import { requestFromWindow } from '../../bus/window-requests.js'
import { REJECTED, ROLE_RETURNED } from '../../core/events.js'
import { cloudOn } from '../../ghosts/cloud-key.js'
import { roleOutcome } from '../../ghosts/role.js'
import { windowEndObserver } from '../../miko/role-end.js'

describe('ghosts:role', () => {
  it('ghosts:role with CONSTRUCT_CLOUD unset launches the role locally, as today', () => {
    expect(roleOutcome(['review', '--task', 't1'], {})).toEqual({ code: 0, out: ['local: launch the review agent for t1'], err: [] })
    expect(roleOutcome(['scan', '--task', 't1'], { CONSTRUCT_CLOUD: 'off' }).out).toEqual(['local: launch the scan agent for t1'])
  })

  it('names the branch, the files and the acceptance when CONSTRUCT_CLOUD is 1', () => {
    const outcome = roleOutcome(['review', '--task', 't1'], { CONSTRUCT_CLOUD: '1' })
    expect(outcome.code).toBe(0)
    expect(outcome.out).toEqual(['cloud: review for t1 runs as a cloud session; it pushes role/t1-review with role/t1/review.md (and, for review, role/t1/review.verdict.json); accept with pnpm ghosts:verdict --from <ref> ...'])
  })

  it.each([
    { name: 'an unknown role', argv: ['plan', '--task', 't1'] },
    { name: 'a missing task', argv: ['brief'] },
    { name: 'an unknown option', argv: ['review', '--task', 't1', '--bogus'] },
  ])('prints usage on stderr and exits 1 for $name', ({ argv }) => {
    const outcome = roleOutcome(argv, {})
    expect(outcome.code).toBe(1)
    expect(outcome.out).toEqual([])
    expect(outcome.err[0]).toContain('usage: role.ts')
  })

  it('reads only the value 1 as cloud; 0, unset and anything else stay local', () => {
    expect([{ CONSTRUCT_CLOUD: '1' }, { CONSTRUCT_CLOUD: '0' }, { CONSTRUCT_CLOUD: 'on' }, {}].map(cloudOn)).toEqual([true, false, false, false])
  })
})

const INCIDENT = path.join(import.meta.dirname, '../bus/fixtures/role-returned-incident.json')
const INCIDENT_COLUMNS = ['id', 'ts', 'type', 'actor', 'card_id', 'pr', 'head', 'dedupe_key', 'payload', 'legacy']

describe('the window role with the owner', () => {
  const HANDOFF = '/handoff/miko.md'
  const START = Date.parse('2026-10-20T10:00:00.000Z')
  const at = (ms: number): string => new Date(START + ms).toISOString()

  function ownerBus(): { db: DatabaseSync, file: string, close: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), 'role-owner-'))
    const file = path.join(root, 'bus.db')
    const db = openBus(file)
    observeRoleStop(db, at(0), 'worker:miko:7', { role: 'miko', handoff: HANDOFF, status: 'CONTINUE', reason: 'context', raised: false })
    reduce(db)
    expect(roleToOwner(db, at(10), 'worker:restart:w')).toMatchObject({ role: 'miko' })
    reduce(db)
    return { db, file, close: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    } }
  }

  const roleRow = (db: DatabaseSync): unknown => db.prepare('SELECT state, raises, failures FROM roles WHERE role = ?').get('miko')

  it('an owner session that ended without miko:exit returns the role once its window is silent, and the bus sends it to the owner again', () => {
    const bus = ownerBus()
    requestFromWindow(bus.db, at(1000), 'owner-session', { kind: 'status' })
    expect(returnSilentRole(bus.db, at(1000 + LEASE_MS - 1), 'worker:restart:w')).toBeNull()

    expect(returnSilentRole(bus.db, at(1001 + LEASE_MS), 'worker:restart:w')).toEqual({ role: 'miko', handoff: HANDOFF, lastSign: at(1000) })
    expect(roleRow(bus.db)).toEqual({ state: 'stopped', raises: 0, failures: 0 })
    const live = projectionDump(bus.db)
    reduce(bus.db)
    expect(projectionDump(bus.db)).toBe(live)
    expect(roleToOwner(bus.db, at(1002 + LEASE_MS), 'worker:restart:w')).toMatchObject({ role: 'miko', handoff: HANDOFF })
    bus.close()
  })

  it('a role with the owner stays there while no owner session has shown itself, or while its window is live', () => {
    const bus = ownerBus()
    expect(returnSilentRole(bus.db, at(10 * LEASE_MS), 'worker:restart:w')).toBeNull()
    requestFromWindow(bus.db, at(10 * LEASE_MS), 'owner-session', { kind: 'status' })
    requestFromWindow(bus.db, at(10.5 * LEASE_MS), 'owner-session', { kind: 'status' })
    expect(returnSilentRole(bus.db, at(11.2 * LEASE_MS), 'worker:restart:w')).toBeNull()
    expect(roleRow(bus.db)).toEqual({ state: 'owner', raises: 0, failures: 0 })
    bus.close()
  })

  it('a live window with a heartbeat keeps its role', () => {
    const bus = ownerBus()
    requestFromWindow(bus.db, at(1000), 'owner-session', { kind: 'status' })
    const beats = [0.5, 1, 1.5, 2, 2.5, 3].map(lease => at(1000 + lease * LEASE_MS))
    for (const beat of beats) {
      expect(returnSilentRole(bus.db, beat, 'worker:restart:w')).toBeNull()
      expect(recordWindowHeartbeat(bus.db, beat, 'owner-session')).toBe(true)
    }
    expect(returnSilentRole(bus.db, at(1000 + 3.9 * LEASE_MS), 'worker:restart:w')).toBeNull()
    expect(roleRow(bus.db)).toMatchObject({ state: 'owner' })

    expect(returnSilentRole(bus.db, at(1001 + 4 * LEASE_MS), 'worker:restart:w')).toEqual({ role: 'miko', handoff: HANDOFF, lastSign: beats.at(-1) })
    bus.close()
  })

  it('a replay after role.returned matches the live roles row', () => {
    const incident = JSON.parse(readFileSync(INCIDENT, 'utf8')) as Record<string, SQLInputValue>[]
    const returnedAt = incident.find(row => row.type === ROLE_RETURNED)!.id as number
    const db = openBus(':memory:')
    const insert = db.prepare(`INSERT INTO events (${INCIDENT_COLUMNS.join(', ')}) VALUES (${INCIDENT_COLUMNS.map(() => '?').join(', ')})`)
    const append = (rows: Record<string, SQLInputValue>[]): void => rows.forEach(row => insert.run(...INCIDENT_COLUMNS.map(column => row[column]!)))
    append(incident.filter(row => (row.id as number) < returnedAt))
    reduce(db)
    append(incident.filter(row => (row.id as number) >= returnedAt))
    reduceProjection(db, ROLES_PROJECTION)
    const liveRow = { state: 'stopped', lease_gen: 12, event_id: incident.at(-1)!.id }
    const rolesRow = (): unknown => db.prepare('SELECT state, lease_gen, event_id FROM roles WHERE role = ?').get('miko')
    expect(rolesRow()).toEqual(liveRow)

    expect(replayDifferences(db).differences).toEqual([])
    const live = projectionDump(db)
    reduce(db)
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${REJECTED}' AND json_extract(payload, '$.type') LIKE 'role.%'`).get()).toEqual({ n: 0 })
    expect(rolesRow()).toEqual(liveRow)
    expect(projectionDump(db)).toBe(live)
    db.close()
  })

  it.each(WINDOW_ENDS)('the end of a window session by Eddies, miko:exit or close returns the role as an event (%s)', (end) => {
    const bus = ownerBus()
    requestFromWindow(bus.db, at(1000), 'owner-session', { kind: 'status' })
    recordWindowHeartbeat(bus.db, at(2000), 'owner-session')

    expect(returnEndedRole(bus.db, at(3000), 'worker:miko:7', 'miko', end)).toEqual({ role: 'miko', handoff: HANDOFF, lastSign: at(3000) })
    const returned = bus.db.prepare('SELECT ts, payload FROM events WHERE type = ?').all(ROLE_RETURNED) as { ts: string, payload: string }[]
    expect(returned.map(row => ({ ts: row.ts, ended: (JSON.parse(row.payload) as { ended: string }).ended }))).toEqual([{ ts: at(3000), ended: end }])
    expect(roleRow(bus.db)).toEqual({ state: 'stopped', raises: 0, failures: 0 })
    expect(returnEndedRole(bus.db, at(3001), 'worker:miko:7', 'miko', end)).toBeNull()

    const live = projectionDump(bus.db)
    reduce(bus.db)
    expect(projectionDump(bus.db)).toBe(live)
    expect(roleToOwner(bus.db, at(3002), 'worker:restart:w')).toMatchObject({ role: 'miko', handoff: HANDOFF })
    bus.close()
  })

  it('a window that ends while the role is not with the owner writes no event, and the observer the loop and miko:exit use writes it through the bus file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'role-end-'))
    const db = openBus(path.join(root, 'bus.db'))
    observeRoleStop(db, at(0), 'worker:miko:7', { role: 'miko', handoff: HANDOFF, status: 'CONTINUE', reason: 'context', raised: false })
    expect(returnEndedRole(db, at(1), 'worker:miko:7', 'miko', 'close')).toBeNull()
    expect(db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(ROLE_RETURNED)).toEqual({ n: 0 })
    db.close()
    rmSync(root, { recursive: true, force: true })

    const bus = ownerBus()
    const lines: string[] = []
    windowEndObserver({ busPath: bus.file, pid: 7, now: () => new Date(at(5000)), err: line => lines.push(line) })('close')
    expect(roleRow(bus.db)).toMatchObject({ state: 'stopped' })
    expect(lines).toEqual(['the window ended by close: role miko returned to the bus'])
    bus.close()
  })
})
