import type { ExitReadings } from '../../window/eddies-measure.js'
import type { MikoExitDeps } from '../../window/exit.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { WINDOW_HEARTBEAT } from '../../core/events.js'
import { doneWaitsForTheOwner, ownerMessagesOf, runMikoExit } from '../../window/exit.js'
import { AGENTS_FILE, liveAgentsOf, sessionTranscriptOf, stoppedTasksIn, stoppedTasksOf } from '../../window/window-agents.js'
import { WINDOW_BEAT_MS, windowBeat, windowOf } from '../../window/window-heartbeat.js'
import { SESSION_VARIABLE } from '../../window/window-requests.js'

const BELOW = { context: 1000, contextWarn: 200000, spent: 0, spendWarn: 2400000 } as unknown as ExitReadings
const SESSION = 's-window'
const START = Date.parse('2026-10-29T10:00:00Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'windowloop-'))
  roots.push(root)
  return root
}

function exitAtDone(overrides: Partial<MikoExitDeps>): { code: number, lines: string[], requests: string[] } {
  const lines: string[] = []
  const requests: string[] = []
  const code = runMikoExit({
    pid: 14,
    table: () => [],
    handoffMtime: () => 0,
    now: () => 0,
    kill: () => {},
    loopRequest: '/r',
    requestEnd: request => requests.push(request),
    err: line => lines.push(line),
    readings: () => BELOW,
    recordExit: () => {},
    handoff: '/h/miko.md',
    status: () => 'DONE',
    liveAgents: () => [],
    dirtyTrees: () => [],
    ...overrides,
  })
  return { code, lines, requests }
}

const user = (content: unknown, extra: object = {}): string => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })
const assistant = (content: unknown[]): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } })
const taskStop = (id: string): string => assistant([{ type: 'tool_use', id: `t-${id}`, name: 'TaskStop', input: { task_id: id } }])
const agentLine = (event: string, id: string): string => JSON.stringify({ event, id, type: 'implementer', session: SESSION })

describe('the window loop on DONE, a stopped subagent and a second window', () => {
  it('done waits for the owner first message: with only the start prompt the session is not ended', () => {
    const transcript = [user('прочитай handoff'), assistant([{ type: 'text', text: 'DONE' }]), user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), user('<command-name>/x</command-name>'), user('meta', { isMeta: true })].join('\n')
    expect(ownerMessagesOf(transcript)).toBe(1)
    const waiting = exitAtDone({ ownerMessages: () => ownerMessagesOf(transcript) })
    expect(waiting.code).toBe(1)
    expect(waiting.requests).toEqual([])
    expect(waiting.lines.join('\n')).toContain(doneWaitsForTheOwner())
    const spoken = `${transcript}\n${user([{ type: 'text', text: 'новая задача' }])}`
    expect(ownerMessagesOf(spoken)).toBe(2)
    expect(exitAtDone({ ownerMessages: () => ownerMessagesOf(spoken) })).toMatchObject({ code: 0, requests: ['/r'] })
    expect(exitAtDone({ ownerMessages: () => null })).toMatchObject({ code: 0, requests: ['/r'] })
  })

  it('a stopped subagent is not live: a TaskStop in the session transcript strikes its start line', () => {
    const root = scratch()
    mkdirSync(path.join(root, '.construct'))
    writeFileSync(path.join(root, AGENTS_FILE), [agentLine('start', 'a1'), agentLine('start', 'a2')].map(line => `${line}\n`).join(''))
    const home = path.join(root, 'home')
    const project = path.join(home, '.claude', 'projects', '-repo')
    mkdirSync(project, { recursive: true })
    writeFileSync(path.join(project, `${SESSION}.jsonl`), [user('go'), taskStop('a1'), 'not json'].join('\n'))
    const transcript = sessionTranscriptOf(home, SESSION)
    expect(transcript).toBe(path.join(project, `${SESSION}.jsonl`))
    expect(stoppedTasksOf(taskStop('a1'))).toEqual(new Set(['a1']))
    const env = { [SESSION_VARIABLE]: SESSION }
    expect(liveAgentsOf(root, env)).toEqual(['implementer', 'implementer'])
    expect(liveAgentsOf(root, env, stoppedTasksIn(transcript))).toEqual(['implementer'])
    writeFileSync(path.join(project, `${SESSION}.jsonl`), [taskStop('a1'), taskStop('a2')].join('\n'))
    expect(liveAgentsOf(root, env, stoppedTasksIn(transcript))).toEqual([])
    expect(stoppedTasksIn(null)).toEqual(new Set())
    expect(sessionTranscriptOf(home, '../escape')).toBeNull()
  })

  it('a second window names the first before writing its own beat', () => {
    const bus = path.join(scratch(), 'bus.db')
    openBus(bus).close()
    const first = windowOf({ CLAUDE_CODE_SESSION_ID: 'first', CLAUDE_PROJECT_DIR: '/repo' })
    expect(first).toMatchObject({ session: 'first', root: '/repo' })
    const lines: string[] = []
    const say = (line: string): void => {
      lines.push(line)
    }
    windowBeat(bus, first, () => START, () => ({}), say)()
    expect(lines).toEqual([])
    windowBeat(bus, { session: 'elsewhere', mode: 'loop', root: '/other' }, () => START, () => ({}), say)()
    expect(lines).toEqual([])
    const second = windowBeat(bus, { session: 'second', mode: 'loop', root: '/repo' }, () => START + 1, () => ({}), say)
    second()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('/repo')
    expect(lines[0]).toContain('session first')
    expect(lines[0]).not.toContain('elsewhere')
    const db = openBus(bus)
    const written = db.prepare(`SELECT json_extract(payload, '$.session') AS session, json_extract(payload, '$.root') AS root FROM events WHERE type = ? ORDER BY id`).all(WINDOW_HEARTBEAT)
    db.close()
    expect(written.map(row => ({ ...row }))).toEqual([{ session: 'first', root: '/repo' }, { session: 'elsewhere', root: '/other' }, { session: 'second', root: '/repo' }])
    const later = windowBeat(bus, { session: 'third', mode: 'loop', root: '/repo' }, () => START + 60 * WINDOW_BEAT_MS, () => ({}), say)
    later()
    expect(lines).toHaveLength(1)
  })
})
