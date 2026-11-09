import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { psPgid } from '../../nodes/launch/launch-starter.js'
import { commandLineOf } from '../../nodes/restart/chain-process.js'
import { InMemoryProcessTable, OsProcessTable, parseListing, rowOf } from '../../ports/process-table.js'
import { outsideOwnGroup } from '../../supervisor/supervisor.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!
}

function pathWithFailingListing(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'process-table-failing-'))
  writeFileSync(path.join(dir, 'ps'), '#!/bin/sh\necho "ps: stub failure" >&2\nexit 1\n')
  chmodSync(path.join(dir, 'ps'), 0o755)
  return `${dir}${path.delimiter}${process.env.PATH}`
}

const DEFAULT_MAX_BUFFER = 1024 * 1024
const BUSY_TABLE_ROWS = 40_000
const BUSY_LINE = '  412     1   412 Sat Nov  8 04:21:20 2026 node --import tsx scripts/a.ts --flag x'

function pathWithBusyListing(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'process-table-busy-'))
  writeFileSync(path.join(dir, 'ps'), `#!/bin/sh\nyes '${BUSY_LINE}' | head -n ${BUSY_TABLE_ROWS}\n`)
  chmodSync(path.join(dir, 'ps'), 0o755)
  return `${dir}${path.delimiter}${process.env.PATH}`
}

describe('the process table port', () => {
  it('the ps listing is read with a buffer larger than the default', () => {
    expect((BUSY_LINE.length + 1) * BUSY_TABLE_ROWS).toBeGreaterThan(DEFAULT_MAX_BUFFER)
    vi.stubEnv('PATH', pathWithBusyListing())
    const snapshot = new OsProcessTable().snapshot()

    expect(snapshot.readable ? snapshot.rows.length : snapshot.reason).toBe(BUSY_TABLE_ROWS)
  })

  it('the in-memory adapter answers as the live one for an alive and a dead pid', () => {
    const gone = deadPid()
    const live = new OsProcessTable().snapshot()
    const own = rowOf(live, process.pid)

    expect(own?.pid).toBe(process.pid)
    expect(rowOf(live, gone)).toBeNull()

    const memory = new InMemoryProcessTable({ rows: [own!] }).snapshot()
    expect(rowOf(memory, process.pid)).toEqual(own)
    expect(rowOf(memory, gone)).toBeNull()
  })

  it('parses pid, parent, group, start and the whole command of a listing line', () => {
    expect(parseListing('  412     1   412 Sat Nov  8 04:21:20 2026 node --import tsx scripts/a.ts --flag x\n')).toEqual([
      { pid: 412, ppid: 1, pgid: 412, started: 'Sat Nov 8 04:21:20 2026', command: 'node --import tsx scripts/a.ts --flag x' },
    ])
  })

  it('an unreadable table answers no row rather than a guess', () => {
    const snapshot = new InMemoryProcessTable({ rows: { unreadable: 'ps: Operation not permitted' } }).snapshot()

    expect(snapshot).toEqual({ readable: false, reason: 'ps: Operation not permitted' })
    expect(rowOf(snapshot, process.pid)).toBeNull()
  })

  it.each([
    { name: 'absent from PATH', searchPath: () => mkdtempSync(path.join(tmpdir(), 'process-table-empty-')), reason: 'ENOENT' },
    { name: 'failing', searchPath: pathWithFailingListing, reason: 'Command failed: ps' },
  ])('the live table is unreadable, with the reason, when its program is $name', ({ searchPath, reason }) => {
    vi.stubEnv('PATH', searchPath())
    const snapshot = new OsProcessTable().snapshot()

    expect(snapshot.readable).toBe(false)
    expect(snapshot.readable ? '' : snapshot.reason).toContain(reason)
  })

  it('the in-memory adapter holds the client cwds and the cpu sample it is given', () => {
    const table = new InMemoryProcessTable({ cwds: { kind: 'listed', cwds: ['/trees/1'] }, cpu: 'COMMAND %CPU' })

    expect(table.clientCwds()).toEqual({ kind: 'listed', cwds: ['/trees/1'] })
    expect(table.cpuSample()).toBe('COMMAND %CPU')
    expect(new InMemoryProcessTable({}).clientCwds()).toEqual({ kind: 'listed', cwds: [] })
  })
})

describe('the callers read facts from the port', () => {
  const row = (pid: number, pgid: number, command: string) => ({ pid, ppid: 1, pgid, started: 'Sat Nov 8 04:21:20 2026', command })

  it('the group of a pid is its row, and a pid with no row or an unreadable table throws', () => {
    expect(psPgid(7, new InMemoryProcessTable({ rows: [row(7, 70, 'node a')] }))).toBe(70)
    expect(() => psPgid(8, new InMemoryProcessTable({ rows: [row(7, 70, 'node a')] }))).toThrow('no process 8 in the process table')
    expect(() => psPgid(7, new InMemoryProcessTable({ rows: { unreadable: 'ps refused' } }))).toThrow('ps refused')
  })

  it('the command line of a pid is its row, and an empty command or no row is null', () => {
    const table = new InMemoryProcessTable({ rows: [row(7, 7, 'node a --flag'), row(8, 8, '')] })
    expect(commandLineOf(7, table)).toBe('node a --flag')
    expect(commandLineOf(8, table)).toBeNull()
    expect(commandLineOf(9, table)).toBeNull()
    expect(commandLineOf(7, new InMemoryProcessTable({ rows: { unreadable: 'ps refused' } }))).toBeNull()
  })

  it('outside its own group leaves out the group of its row, or its own pid as the group when it has no row', () => {
    const rows = [row(10, 10, 'node a'), row(11, 10, 'node b'), row(20, 20, 'node c'), row(30, 30, 'node d')]
    expect(outsideOwnGroup(new InMemoryProcessTable({ rows }), 11)().map(each => each.pid)).toEqual([20, 30])
    expect(outsideOwnGroup(new InMemoryProcessTable({ rows }), 30)().map(each => each.pid)).toEqual([10, 11, 20])
  })

  it('outside its own group with no row of its own takes its pid as the group, and an unreadable table throws when listed', () => {
    expect(outsideOwnGroup(new InMemoryProcessTable({ rows: [row(10, 10, 'node a'), row(41, 40, 'node f')] }), 40)().map(each => each.pid)).toEqual([10])
    expect(() => outsideOwnGroup(new InMemoryProcessTable({ rows: { unreadable: 'ps refused' } }), 40)()).toThrow('ps refused')
  })
})
