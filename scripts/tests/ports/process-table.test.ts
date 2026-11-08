import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryProcessTable, OsProcessTable, parseListing, rowOf } from '../../ports/process-table.js'

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

describe('the process table port', () => {
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
