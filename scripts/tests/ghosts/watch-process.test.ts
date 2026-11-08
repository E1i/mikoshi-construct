import type { ProcessSnapshot } from '../../ports/process-table.js'
import { describe, expect, it } from 'vitest'
import { isSessionAlive, processField } from '../../ladder/watch-process.js'

function row(command: string) {
  return { pid: 1, ppid: 0, pgid: 1, started: 'Sat Nov 8 04:21:20 2026', command }
}

describe('processField', () => {
  const snapshot: ProcessSnapshot = { readable: true, rows: [row('claude --session-id abc-123')] }

  it('names no session when the status row carries none', () => {
    expect(processField(undefined, snapshot)).toBe('process no session')
  })

  it('reads alive or dead from a readable table', () => {
    expect(processField('abc-123', snapshot)).toBe('process alive')
    expect(processField('other', snapshot)).toBe('process dead')
  })

  it('reads unknown with the reason, never dead, from an unreadable table', () => {
    expect(processField('abc-123', { readable: false, reason: 'spawnSync ps ENOENT' })).toBe('process unknown (the process table could not be read: spawnSync ps ENOENT)')
  })
})

describe('isSessionAlive', () => {
  it('is true when a process carries --session-id <uuid> in its arguments', () => {
    expect(isSessionAlive('abc-123', [row('node script.js --session-id abc-123 /implement brief.md')])).toBe(true)
  })

  it('is false when no process carries that session id', () => {
    expect(isSessionAlive('abc-123', [row('node script.js --session-id other-id /implement brief.md')])).toBe(false)
  })
})
