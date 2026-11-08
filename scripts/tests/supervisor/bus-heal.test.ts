import type { DatabaseSync } from 'node:sqlite'
import type { ProcessSignals } from '../../supervisor/bus-heal.js'
import { Buffer } from 'node:buffer'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupsDirOf, BUS_FILE, busDirOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { BUS_HEALED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { openDatabase } from '../../core/sqlite.js'
import { BUS_RUN_LAUNCH } from '../../supervisor/bg.js'
import { BusHealer, CONTROL_FILE, CorruptionWatch, eventsControl, HEAL_FLAG, integrityOf, laggingWatermarks, NODES_RECORD, RecordedNodes } from '../../supervisor/bus-heal.js'

const NOW = new Date('2026-11-03T12:00:00.000Z')
const EVENTS = 60
const CORRUPT_LINE = 'Error: database disk image is malformed { errcode: 11, code: \'ERR_SQLITE_ERROR\' }'
const OWN_PIDS = [41_001, 41_002]
const OTHER_PID = 52_001

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-bus-heal-'))
  roots.push(root)
  return root
}

function seededBus(root: string, name: string): string {
  const busPath = path.join(root, name, BUS_FILE)
  mkdirSync(path.dirname(busPath), { recursive: true })
  const db = openBus(busPath)
  for (let index = 0; index < EVENTS; index++)
    appendEvent(db, { ts: NOW.toISOString(), type: `kind${index % 5}`, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `seed:${index}`, payload: { index, text: 'x'.repeat(200) }, legacy: false })
  reduce(db)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  return busPath
}

function pageOf(busPath: string, name: string): { offset: number, size: number } {
  const db = openDatabase(busPath)
  try {
    const root = Number((db.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(name) as { rootpage: number }).rootpage)
    const size = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
    return { offset: (root - 1) * size, size }
  }
  finally {
    db.close()
  }
}

function rewritePage(busPath: string, name: string, rewrite: (page: Buffer) => void): void {
  const { offset, size } = pageOf(busPath, name)
  const fd = openSync(busPath, 'r+')
  try {
    const page = Buffer.alloc(size)
    readSync(fd, page, 0, size, offset)
    rewrite(page)
    writeSync(fd, page, 0, size, offset)
  }
  finally {
    closeSync(fd)
  }
}

function breakEventsIndex(busPath: string): void {
  rewritePage(busPath, 'events_by_type', (page) => {
    for (let at = page.indexOf('kind1'); at !== -1; at = page.indexOf('kind1', at + 1))
      page.write('kindZ', at)
  })
}

function breakEventsTable(busPath: string): void {
  rewritePage(busPath, 'events', page => page.fill(0xFF))
}

function onBus<T>(busPath: string, read: (db: DatabaseSync) => T): T {
  const db = openDatabase(busPath)
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

interface Signals extends ProcessSignals {
  sent: { pid: number, name: string }[]
}

function fakeSignals(): Signals {
  const sent: { pid: number, name: string }[] = []
  const stopped = new Set<number>()
  return {
    sent,
    signal: (pid, name) => {
      sent.push({ pid, name })
      stopped.add(pid)
    },
    runsNodeOfThisBus: pid => !stopped.has(pid),
    runningOnThisBus: () => [],
    pause: async () => {},
    now: () => NOW,
  }
}

function recordedNodes(busPath: string, signals: Signals, pids: readonly number[]): RecordedNodes {
  const nodes = new RecordedNodes(busPath, signals)
  pids.forEach((pid, index) => nodes.started({ ...BUS_RUN_LAUNCH, script: `bus:node${index}` }, { stdout: [String(pid)], stderr: [], exitCode: 0 }))
  return nodes
}

function healer(busPath: string, nodes: RecordedNodes): BusHealer {
  return new BusHealer({ busPath, nodes, now: () => NOW, watch: new CorruptionWatch([]) })
}

describe('the bus heals a broken events index', () => {
  it('a copy with a broken events index is healed with nodes stopped, a backup kept, integrity ok, every event in place and nodes restarted', async () => {
    const busPath = seededBus(newRoot(), 'own')
    const before = onBus(busPath, db => eventsControl(db))
    breakEventsIndex(busPath)
    expect(onBus(busPath, integrityOf)).not.toEqual(['ok'])
    const signals = fakeSignals()
    const nodes = recordedNodes(busPath, signals, OWN_PIDS)

    const lines = await healer(busPath, nodes).step([CORRUPT_LINE])

    expect(signals.sent.filter(each => each.name === 'SIGTERM').map(each => each.pid)).toEqual(OWN_PIDS)
    const backup = path.join(backupsDirOf(busPath), NOW.toISOString().replace(/[:.]/g, '-'))
    expect(existsSync(path.join(backup, BUS_FILE))).toBe(true)
    expect(JSON.parse(readFileSync(path.join(backup, CONTROL_FILE), 'utf8'))).toEqual({ max_id: before.maxId, count: before.count, digest: before.digest })
    expect(onBus(busPath, integrityOf)).toEqual(['ok'])
    expect(onBus(busPath, db => eventsControl(db, before.maxId))).toEqual(before)
    expect(onBus(busPath, laggingWatermarks)).toEqual([])
    const healed = onBus(busPath, db => db.prepare('SELECT payload FROM events WHERE type = ?').all(BUS_HEALED) as { payload: string }[])
    expect(healed).toHaveLength(1)
    expect(JSON.parse(healed[0]!.payload)).toMatchObject({ backup, max_id: before.maxId, count: before.count, steps: expect.arrayContaining(['REINDEX events', 'VACUUM', 'integrity_check ok']) })
    expect(JSON.parse(healed[0]!.payload).broken.length).toBeGreaterThan(0)
    expect(nodes.held()).toBe(false)
    expect(lines.some(line => line.startsWith('question:'))).toBe(false)
  })

  it('a broken events table is not healed, the nodes stay stopped and the owner gets one question', async () => {
    const busPath = seededBus(newRoot(), 'own')
    breakEventsTable(busPath)
    const signals = fakeSignals()
    const nodes = recordedNodes(busPath, signals, OWN_PIDS)
    const heal = healer(busPath, nodes)

    const first = await heal.step([CORRUPT_LINE])
    const second = await heal.step([CORRUPT_LINE])

    expect(first.filter(line => line.startsWith('question:'))).toHaveLength(1)
    expect(first.find(line => line.startsWith('question:'))).toContain('reading the events table of the backup whole NOT INDEXED failed')
    expect(second).toEqual([])
    expect(nodes.held()).toBe(true)
    expect(nodes.heldForOwner()).toBe(true)
    expect(existsSync(path.join(backupsDirOf(busPath), NOW.toISOString().replace(/[:.]/g, '-'), BUS_FILE))).toBe(true)
    expect(signals.sent.filter(each => each.name === 'SIGTERM').map(each => each.pid)).toEqual(OWN_PIDS)
  })

  it('the nodes of another bus are not stopped', async () => {
    const root = newRoot()
    const own = seededBus(root, 'own')
    const other = seededBus(root, 'other')
    breakEventsIndex(own)
    const signals = fakeSignals()
    const otherNodes = recordedNodes(other, signals, [OTHER_PID])
    const nodes = recordedNodes(own, signals, OWN_PIDS)
    const record = path.join(busDirOf(own), NODES_RECORD)
    writeFileSync(record, JSON.stringify([...JSON.parse(readFileSync(record, 'utf8')) as unknown[], { script: 'bus:run', pid: OTHER_PID, bus: other }]))

    await healer(own, nodes).step([CORRUPT_LINE])

    expect(signals.sent.map(each => each.pid)).not.toContain(OTHER_PID)
    expect(signals.sent.map(each => each.pid)).toEqual(expect.arrayContaining(OWN_PIDS))
    expect(existsSync(path.join(busDirOf(other), HEAL_FLAG))).toBe(false)
    expect(otherNodes.held()).toBe(false)
    expect(onBus(other, integrityOf)).toEqual(['ok'])
  })

  it('a recorded pid that is no longer a node of this bus is dropped from the record and never signalled', async () => {
    const busPath = seededBus(newRoot(), 'own')
    breakEventsIndex(busPath)
    const signals = fakeSignals()
    const reused = OWN_PIDS[1]!
    const nodes = recordedNodes(busPath, { ...signals, runsNodeOfThisBus: pid => pid !== reused && signals.runsNodeOfThisBus(pid, '') }, OWN_PIDS)

    await healer(busPath, nodes).step([CORRUPT_LINE])

    expect(signals.sent.map(each => each.pid)).not.toContain(reused)
    expect(signals.sent.map(each => each.pid)).toContain(OWN_PIDS[0])
    expect(readFileSync(path.join(busDirOf(busPath), NODES_RECORD), 'utf8')).not.toContain(String(reused))
  })

  it('a quiet bus is not touched: no corruption seen, no node stopped', async () => {
    const busPath = seededBus(newRoot(), 'own')
    const signals = fakeSignals()
    const nodes = recordedNodes(busPath, signals, OWN_PIDS)

    expect(await healer(busPath, nodes).step(['a line with nothing broken'])).toEqual([])
    expect(signals.sent).toEqual([])
    expect(existsSync(backupsDirOf(busPath))).toBe(false)
  })

  it('a node log that gains a SQLITE_CORRUPT line after the watch began is seen, an older one is not', () => {
    const root = newRoot()
    const log = path.join(root, 'update.log')
    writeFileSync(log, `${CORRUPT_LINE}\n`)
    const watch = new CorruptionWatch([log])

    expect(watch.seen([])).toBeNull()
    writeFileSync(log, `${CORRUPT_LINE}\nok\n${CORRUPT_LINE}\n`)
    expect(watch.seen([])).toBe(CORRUPT_LINE)
    expect(watch.seen([])).toBeNull()
  })
})
