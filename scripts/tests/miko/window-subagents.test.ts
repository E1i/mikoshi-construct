import type { WindowSubagent } from '../../window/window-subagents.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busReaderAt } from '../../../src/commands/board/bus.js'
import { PLAIN_LORE } from '../../../src/ui/lore.js'
import { openBus } from '../../core/db.js'
import { recordWindowSubagent, runWindowSubagent, windowSubagentCall, windowSubagentKey } from '../../window/window-subagents.js'

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

function windowTileOf(name: string): object {
  return { role: 'window', task: 'miko', tree: null, step: PLAIN_LORE.boardWindowAgentsStep, session: 's1', subagents: [{ name, context: null, spent: null, at: AT.toISOString() }] }
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

  it('a step advancing on one running session stays one subagent of the window tile', () => {
    const file = busFile()
    const db = openBus(file)
    const started = { session: 's1', role: 'implementer', task: '#1071', phase: 'started' as const, tree: '/t' }
    expect(recordWindowSubagent(db, { ...started, step: 'implement 1/3 @ low' }, AT)).toBe(true)
    expect(recordWindowSubagent(db, { ...started, step: 'implement 2/3 @ medium' }, AT)).toBe(true)
    const running = busReaderAt(file, () => AT)()
    expect(running.status === 'read' && running.facts.services).toEqual([windowTileOf('implementer')])
    db.close()
  })

  it('counts on the window tile while it runs and stops when it ends', () => {
    const file = busFile()
    const db = openBus(file)
    recordWindowSubagent(db, { session: 's1', role: 'implementer', task: '#1071', phase: 'started', tree: '/t', step: 'implement 1/3 @ high' }, AT)
    const running = busReaderAt(file, () => AT)()
    expect(running.status === 'read' && running.facts.services).toEqual([windowTileOf('implementer')])
    recordWindowSubagent(db, { session: 's1', role: 'implementer', task: '#1071', phase: 'ended' }, AT)
    const ended = busReaderAt(file, () => AT)()
    expect(ended.status === 'read' && ended.facts.services).toEqual([])
    db.close()
  })

  it('two agents of one window session are two subagents, keyed and dropped by their agent id', () => {
    const file = busFile()
    const db = openBus(file)
    const of = (agent: string, phase: 'started' | 'ended'): WindowSubagent => ({ session: 's1', role: 'scan', phase, agent })
    expect(recordWindowSubagent(db, of('a1', 'started'), AT)).toBe(true)
    expect(recordWindowSubagent(db, of('a2', 'started'), AT)).toBe(true)
    expect(recordWindowSubagent(db, of('a1', 'started'), AT)).toBe(false)
    expect(windowSubagentKey(of('a1', 'started'))).toBe('window.subagent:s1:a1:started')
    const both = busReaderAt(file, () => AT)()
    expect(both.status === 'read' && both.facts.services[0]!.subagents!.map(agent => agent.name)).toEqual(['scan', 'scan'])
    recordWindowSubagent(db, of('a1', 'ended'), AT)
    const one = busReaderAt(file, () => AT)()
    expect(one.status === 'read' && one.facts.services[0]!.subagents).toHaveLength(1)
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
    expect(running.status === 'read' && running.facts.services).toEqual([windowTileOf('brief')])
    expect(runWindowSubagent([], path.join(path.dirname(file), 'never.db'), () => AT)).toBe(1)
  })
})
