import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busReaderAt } from '../../../src/commands/board/bus.js'
import { openBus } from '../../core/db.js'
import { WINDOW_HEARTBEAT, WINDOW_SUBAGENT_EVENT } from '../../core/events.js'
import { superviseUntilReplaced } from '../../supervisor/supervisor.js'
import { WindowSubagentTick } from '../../supervisor/window-subagent-tick.js'
import { AGENTS_FILE } from '../../window/window-agents.js'

const NOW = new Date('2026-11-12T07:20:00.000Z')
const SESSION = '4ae53080'
const PREFIX = 'bus: '
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function project(): { root: string, busPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'window-subagent-tick-'))
  roots.push(root)
  mkdirSync(path.join(root, '.construct'), { recursive: true })
  return { root, busPath: path.join(root, 'bus.db') }
}

function hookLine(root: string, event: 'start' | 'stop', id: string, type: string | null, at: Date = NOW, session: string | null = SESSION): void {
  appendFileSync(path.join(root, AGENTS_FILE), `${JSON.stringify({ event, id, type, session, at: at.toISOString() })}\n`)
}

function windowAgentsOnBoard(busPath: string): string[] {
  const reading = busReaderAt(busPath, () => NOW)()
  if (reading.status !== 'read')
    throw new Error(reading.status)
  return reading.facts.services.flatMap(service => service.role === 'window' ? (service.subagents ?? []).map(agent => agent.name) : [])
}

function subagentKeys(busPath: string): string[] {
  const db = openBus(busPath)
  try {
    return (db.prepare('SELECT dedupe_key FROM events WHERE type = ? ORDER BY id').all(WINDOW_SUBAGENT_EVENT) as { dedupe_key: string }[]).map(row => row.dedupe_key)
  }
  finally {
    db.close()
  }
}

describe('the supervisor tick that publishes the window subagents', () => {
  it('a subagent started with no window pulse shows on the board after the next tick and leaves it once stopped', () => {
    const { root, busPath } = project()
    const db = openBus(busPath)
    const tick = new WindowSubagentTick(db, root, () => NOW.getTime(), PREFIX)
    expect(tick.step()).toEqual([])

    hookLine(root, 'start', 'agent-a', 'scan')
    expect(windowAgentsOnBoard(busPath)).toEqual([])
    expect(tick.step()).toHaveLength(1)
    expect(db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(WINDOW_HEARTBEAT)).toEqual({ n: 0 })
    expect(windowAgentsOnBoard(busPath)).toEqual(['scan'])
    const tile = (busReaderAt(busPath, () => NOW)() as { facts: { services: { session?: string }[] } }).facts.services[0]!
    expect(tile.session).toBe(SESSION)

    hookLine(root, 'stop', 'agent-a', 'scan')
    tick.step()
    expect(windowAgentsOnBoard(busPath)).toEqual([])
    db.close()
  })

  it('rereading the file and restarting the reader record each start and stop exactly once', () => {
    const { root, busPath } = project()
    const db = openBus(busPath)
    hookLine(root, 'start', 'agent-a', 'scan')
    hookLine(root, 'start', 'agent-b', 'scan')
    hookLine(root, 'start', 'no-session', 'scan', NOW, null)
    const first = new WindowSubagentTick(db, root, () => NOW.getTime(), PREFIX)
    first.step()
    first.step()
    expect(windowAgentsOnBoard(busPath)).toEqual(['scan', 'scan'])

    hookLine(root, 'stop', 'agent-a', 'scan')
    const restarted = new WindowSubagentTick(db, root, () => NOW.getTime(), PREFIX)
    expect(restarted.step()).toEqual([`${PREFIX}published 1 window subagent start/stop line(s) from the window agents file to the bus`])
    restarted.step()
    new WindowSubagentTick(db, root, () => NOW.getTime(), PREFIX).step()

    expect(subagentKeys(busPath)).toEqual([
      `${WINDOW_SUBAGENT_EVENT}:${SESSION}:agent-a:started`,
      `${WINDOW_SUBAGENT_EVENT}:${SESSION}:agent-b:started`,
      `${WINDOW_SUBAGENT_EVENT}:${SESSION}:agent-a:ended`,
    ])
    expect(windowAgentsOnBoard(busPath)).toEqual(['scan'])
    db.close()
  })

  it('a start line carries its own time onto the bus and a missing file publishes nothing', () => {
    const { root, busPath } = project()
    const db = openBus(busPath)
    const tick = new WindowSubagentTick(db, path.join(root, 'absent'), () => NOW.getTime(), PREFIX)
    expect(tick.step()).toEqual([])
    const started = new Date(NOW.getTime() - 60_000)
    hookLine(root, 'start', 'agent-a', null, started)
    new WindowSubagentTick(db, root, () => NOW.getTime(), PREFIX).step()
    const row = db.prepare('SELECT ts, payload FROM events WHERE type = ?').get(WINDOW_SUBAGENT_EVENT) as { ts: string, payload: string }
    expect(row.ts).toBe(started.toISOString())
    expect(JSON.parse(row.payload)).toMatchObject({ session: SESSION, role: 'agent', phase: 'started' })
    db.close()
  })

  it('the supervisor loop runs the window subagent tick on each tick, beside the window session ends', async () => {
    const printed: string[] = []
    let ticks = 0
    await superviseUntilReplaced({
      supervisor: { step: async () => [], get ownCodeBehind() {
        return ticks >= 1 ? 'sha' : null
      } } as never,
      keeper: { step: () => [] } as never,
      windowSubagents: { step: () => {
        ticks += 1
        return ['published']
      } },
      relaunch: { busDir: '', start: () => ({ stdout: [], stderr: [], exitCode: 0 }) },
      print: line => printed.push(line),
      pause: async () => {},
    })
    expect(ticks).toBe(1)
    expect(printed).toContain('published')
  })
})
