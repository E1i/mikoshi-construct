import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busReaderAt } from '../../../src/commands/board/bus.js'
import { openBus } from '../../bus/db.js'
import { recordWindowSubagent } from '../../miko/window-subagents.js'

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
    const running = busReaderAt(file)()
    expect(running.status === 'read' && running.facts.services).toEqual([{ role: 'implementer', task: '#1071', tree: '/t', step: 'implement 2/3 @ medium' }])
    db.close()
  })

  it('feeds Services while it runs and stops when it ends', () => {
    const file = busFile()
    const db = openBus(file)
    recordWindowSubagent(db, { session: 's1', role: 'implementer', task: '#1071', phase: 'started', tree: '/t', step: 'implement 1/3 @ high' }, AT)
    const running = busReaderAt(file)()
    expect(running.status === 'read' && running.facts.services).toEqual([{ role: 'implementer', task: '#1071', tree: '/t', step: 'implement 1/3 @ high' }])
    recordWindowSubagent(db, { session: 's1', role: 'implementer', task: '#1071', phase: 'ended' }, AT)
    const ended = busReaderAt(file)()
    expect(ended.status === 'read' && ended.facts.services).toEqual([])
    db.close()
  })
})
