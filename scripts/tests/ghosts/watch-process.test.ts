import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { isSessionAlive, listProcesses } from '../../ghosts/watch-process.js'

describe('listProcesses', () => {
  it('lists this process among running processes, with its pid a positive number', () => {
    const processes = listProcesses()
    expect(processes.length).toBeGreaterThan(0)
    const self = processes.find(entry => entry.pid === process.pid)
    expect(self).toBeDefined()
    expect(self!.pid).toBeGreaterThan(0)
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
