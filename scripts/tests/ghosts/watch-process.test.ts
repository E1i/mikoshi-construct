import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { isSessionAlive, listProcesses, processField } from '../../ghosts/watch-process.js'

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

function pathWithFailingPs(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-watch-ps-'))
  const ps = path.join(dir, 'ps')
  writeFileSync(ps, '#!/bin/sh\necho "ps: stub failure" >&2\nexit 1\n')
  chmodSync(ps, 0o755)
  return `${dir}${path.delimiter}${originalPath}`
}

describe('listProcesses', () => {
  it('lists this process among running processes, with its pid a positive number', () => {
    const listing = listProcesses()
    expect(listing.readable).toBe(true)
    const processes = listing.readable ? listing.processes : []
    const self = processes.find(entry => entry.pid === process.pid)
    expect(self).toBeDefined()
    expect(self!.pid).toBeGreaterThan(0)
  })

  it.each([
    { name: 'absent from PATH', searchPath: () => mkdtempSync(path.join(tmpdir(), 'ghosts-watch-empty-')), reason: 'ENOENT' },
    { name: 'failing', searchPath: pathWithFailingPs, reason: 'Command failed: ps' },
  ])('is unreadable, with the reason, when ps is $name', ({ searchPath, reason }) => {
    process.env.PATH = searchPath()
    const listing = listProcesses()
    expect(listing.readable).toBe(false)
    expect(listing.readable ? '' : listing.reason).toContain(reason)
  })
})

describe('processField', () => {
  const listing = { readable: true as const, processes: [{ pid: 1, args: 'claude --session-id abc-123' }] }

  it('names no session when the status row carries none', () => {
    expect(processField(undefined, listing)).toBe('process no session')
  })

  it('reads alive or dead from a readable listing', () => {
    expect(processField('abc-123', listing)).toBe('process alive')
    expect(processField('other', listing)).toBe('process dead')
  })

  it('reads unknown with the reason, never dead, from an unreadable listing', () => {
    expect(processField('abc-123', { readable: false, reason: 'spawnSync ps ENOENT' })).toBe('process unknown (ps failed: spawnSync ps ENOENT)')
  })
})

describe('isSessionAlive', () => {
  it('is true when a process carries --session-id <uuid> in its arguments', () => {
    const processes = [{ pid: 1, args: 'node script.js --session-id abc-123 /implement brief.md' }]
    expect(isSessionAlive('abc-123', processes)).toBe(true)
  })

  it('is false when no process carries that session id', () => {
    const processes = [{ pid: 1, args: 'node script.js --session-id other-id /implement brief.md' }]
    expect(isSessionAlive('abc-123', processes)).toBe(false)
  })
})
