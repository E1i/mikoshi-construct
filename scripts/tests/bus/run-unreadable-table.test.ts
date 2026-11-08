import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../core/bus-path.js'
import { openBus } from '../../core/db.js'
import { OWNER_WAIT_OPENED } from '../../core/events.js'
import { RUN_SCRIPT } from '../../supervisor/bg.js'
import { recordProcessHeartbeat } from '../../supervisor/heartbeat.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { holdRunLock, RUN_LOCK } from '../../supervisor/run.js'

const HOLDER = 4401
const NOW_MS = Date.parse('2026-11-08T12:00:00.000Z')

const unreadable = (): never => {
  throw new Error('spawnSync ps EPERM')
}

function waitsOpened(busPath: string): { need: string, text: string, command: string }[] {
  const db = openBus(busPath)
  try {
    return (db.prepare('SELECT payload FROM events WHERE type = ?').all(OWNER_WAIT_OPENED) as { payload: string }[]).map(row => JSON.parse(row.payload))
  }
  finally {
    db.close()
  }
}

describe('bus:run facing an unreadable process table', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  function busPathIn(prefix: string): string {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
    roots.push(root)
    return path.join(root, 'bus.db')
  }

  it('bus:run facing an unreadable process table with no recent heartbeat stops with an owner question and takes no lock', () => {
    const busPath = busPathIn('bus-run-silent-')
    const lock = path.join(busDirOf(busPath), RUN_LOCK)
    const db = openBus(busPath)
    recordProcessHeartbeat(db, new Date(NOW_MS - SILENT_MS - 1000).toISOString(), RUN_SCRIPT)
    db.close()
    expect(holdRunLock(busPath, () => [], HOLDER).exitCode).toBe(0)

    const refused = holdRunLock(busPath, unreadable, process.pid, NOW_MS)

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.join('\n')).toContain('spawnSync ps EPERM')
    expect(refused.stderr.join('\n')).toContain('takes no lock')
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(HOLDER))
    const waits = waitsOpened(busPath)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toMatchObject({ need: 'command', command: `rm ${lock}` })
    expect(waits[0]!.text).toContain(`pid ${HOLDER}`)
  })

  it('a second refused bus:run on the same lock asks no second question', () => {
    const busPath = busPathIn('bus-run-silent-twice-')
    openBus(busPath).close()
    expect(holdRunLock(busPath, () => [], HOLDER).exitCode).toBe(0)

    expect(holdRunLock(busPath, unreadable, process.pid, NOW_MS).exitCode).toBe(1)
    expect(holdRunLock(busPath, unreadable, process.pid, NOW_MS + 1000).exitCode).toBe(1)

    expect(waitsOpened(busPath)).toHaveLength(1)
  })

  it('with no bus beside the lock bus:run takes no lock and creates no bus', () => {
    const busPath = busPathIn('bus-run-no-bus-')
    const lock = path.join(busDirOf(busPath), RUN_LOCK)
    expect(holdRunLock(busPath, () => [], HOLDER).exitCode).toBe(0)

    const refused = holdRunLock(busPath, unreadable, process.pid, NOW_MS)

    expect(refused.exitCode).toBe(1)
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(HOLDER))
    expect(existsSync(busPath)).toBe(false)
  })
})
