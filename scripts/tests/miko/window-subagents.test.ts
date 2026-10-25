import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busReaderAt } from '../../../src/commands/board/bus.js'
import { openBus } from '../../core/db.js'
import { recordWindowSubagent, runWindowSubagent, windowSubagentCall } from '../../window/window-subagents.js'

const AT = new Date('2026-10-19T10:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'window-subagents-'))
  roots.push(dir)
  return path.join(dir, 'bus.db')
}

describe('the window subagent event', () => {
  it('is appended once per session and phase', () => {
    const file = busFile()
    const db = openBus(file)
    const started = { session: 's1', role: 'implementer', task: '#1071', phase: 'started' as const, tree: '/trees/mc-1071' }
    expect(recordWindowSubagent(db, started, AT)).toBe(true)
    expect(recordWindowSubagent(db, started, AT)).toBe(false)
    const row = db.prepare('SELECT type, actor, payload FROM events').get() as { type: string, actor: string, payload: string }
    expect([row.type, row.actor, JSON.parse(row.payload)]).toEqual(['window.subagent', 'owner', { session: 's1', role: 'implementer', task: '#1071', phase: 'started', tree: '/trees/mc-1071', step: null }])
    db.close()
  })

  it('advances the step a running session shows in Services', () => {
    const file = busFile()
    const db = openBus(file)
    const started = { session: 's1', role: 'implementer', task: '#1071', phase: 'started' as const, tree: '/t' }
    expect(recordWindowSubagent(db, { ...started, step: 'implement 1/3 @ low' }, AT)).toBe(true)
    expect(recordWindowSubagent(db, { ...started, step: 'implement 2/3 @ medium' }, AT)).toBe(true)
    const running = busReaderAt(file, () => AT)()
    expect(running.status === 'read' && running.facts.services).toEqual([{ role: 'implementer', task: '#1071', tree: '/t', step: 'implement 2/3 @ medium' }])
    db.close()
  })

  it('feeds Services while it runs and stops when it ends', () => {
    const file = busFile()
    const db = openBus(file)
    recordWindowSubagent(db, { session: 's1', role: 'implementer', task: '#1071', phase: 'started', tree: '/t', step: 'implement 1/3 @ high' }, AT)
    const running = busReaderAt(file, () => AT)()
    expect(running.status === 'read' && running.facts.services).toEqual([{ role: 'implementer', task: '#1071', tree: '/t', step: 'implement 1/3 @ high' }])
    recordWindowSubagent(db, { session: 's1', role: 'implementer', task: '#1071', phase: 'ended' }, AT)
    const ended = busReaderAt(file, () => AT)()
    expect(ended.status === 'read' && ended.facts.services).toEqual([])
    db.close()
  })
})

describe('the window subagent command', () => {
  it('reads a subagent from its flags and refuses a missing flag, an unknown phase and an unknown option', () => {
    expect(windowSubagentCall(['--session', 's1', '--role', 'implementer', '--task', '#1', '--phase', 'started', '--tree', '/t', '--step', 'a'])).toEqual({
      kind: 'record',
      subagent: { session: 's1', role: 'implementer', task: '#1', phase: 'started', tree: '/t', step: 'a' },
    })
    expect(windowSubagentCall(['--role', 'implementer', '--task', '#1', '--phase', 'started'])).toMatchObject({ kind: 'refused' })
    expect(windowSubagentCall(['--session', 's1', '--role', 'r', '--task', '#1', '--phase', 'paused'])).toMatchObject({ kind: 'refused' })
    expect(windowSubagentCall(['--nope'])).toMatchObject({ kind: 'refused' })
  })

  it('writes the event the board reads, and exits 1 on a refused call without opening the bus', () => {
    const file = busFile()
    expect(runWindowSubagent(['--session', 's1', '--role', 'brief', '--task', '#9', '--phase', 'started'], file, () => AT)).toBe(0)
    const running = busReaderAt(file, () => AT)()
    expect(running.status === 'read' && running.facts.services).toEqual([{ role: 'brief', task: '#9', tree: null, step: 'started' }])
    expect(runWindowSubagent([], path.join(path.dirname(file), 'never.db'), () => AT)).toBe(1)
  })
})
