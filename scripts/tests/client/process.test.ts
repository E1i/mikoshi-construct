import { describe, expect, it } from 'vitest'
import { isSessionAlive } from '../../ladder/watch-process.js'
import { launchIsolationCommand } from '../../nodes/launch/launch-root.js'
import { reviewIsolationCommand } from '../../nodes/review/review-worker.js'
import { clientCwdsCommand } from '../../ports/process-table.js'
import { claudeClient } from './claude-client.js'

const SESSION = 'session-1578'
const HEADLESS_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none', '--strict-mcp-config', '--session-id']

describe('the client process', () => {
  it('the adapter recognises the client process and its session marker', () => {
    const { isClient, sessionMarker } = claudeClient.processes
    expect(isClient('claude -p')).toBe(true)
    expect(isClient('/opt/bin/claude --resume x')).toBe(true)
    expect(isClient('node /opt/bin/claude -p')).toBe(true)
    expect(isClient('node tsx /opt/bin/claude')).toBe(false)
    expect(isClient('node scripts/window/exit.ts')).toBe(false)
    expect(sessionMarker(SESSION)).toBe(`--session-id ${SESSION}`)
  })

  it('a session is alive when a process carries the adapter marker', () => {
    const marker = claudeClient.processes.sessionMarker(SESSION)!
    const row = (command: string) => ({ pid: 1, ppid: 0, pgid: 1, started: '', command })
    expect(isSessionAlive(claudeClient.processes, SESSION, [row(`claude -p ${marker} go`)])).toBe(true)
    expect(isSessionAlive(claudeClient.processes, SESSION, [row('claude -p --session-id other go')])).toBe(false)
  })
})

describe('the process names of the client', () => {
  it('reach the process table as the names its cwd search asks for', () => {
    expect(clientCwdsCommand(claudeClient.processes)).toBe(`lsof ${claudeClient.processes.processNames.flatMap(name => ['-c', name]).join(' ')}`)
  })
})

describe('the isolation command', () => {
  it('of a headless session is the client with the headless flags', () => {
    expect(claudeClient.processes.isolationCommand()).toEqual(['claude', ...HEADLESS_FLAGS])
    expect(reviewIsolationCommand(claudeClient)).toEqual(claudeClient.processes.isolationCommand())
  })

  it('of a card session carries the words of the client command before the card permission', () => {
    expect(launchIsolationCommand('claude')).toEqual(['claude', '--permission-mode', 'dontAsk'])
    expect(launchIsolationCommand('/opt/claude --settings /tmp/s.json')).toEqual(['/opt/claude', '--settings', '/tmp/s.json', '--permission-mode', 'dontAsk'])
  })
})
