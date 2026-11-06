import { describe, expect, it, vi } from 'vitest'
import { isSessionAlive } from '../../ladder/watch-process.js'
import { launchIsolationCommand } from '../../nodes/launch/launch-worker.js'
import { reviewIsolationCommand } from '../../nodes/review/review-worker.js'
import { clientAdapter } from '../../ports/client/index.js'

const SESSION = 'session-1578'
const HEADLESS_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none', '--strict-mcp-config', '--session-id']

vi.mock('../../ports/worktree.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../ports/worktree.js')>(),
  claudeProcessCwds: () => ({ kind: 'listed', cwds: ['from the worktree port'] }),
}))

describe('the client process', () => {
  it('the adapter recognises the client process and its session marker', () => {
    const { isClient, sessionMarker } = clientAdapter().processes
    expect(isClient('claude -p')).toBe(true)
    expect(isClient('/opt/bin/claude --resume x')).toBe(true)
    expect(isClient('node /opt/bin/claude -p')).toBe(true)
    expect(isClient('node tsx /opt/bin/claude')).toBe(false)
    expect(isClient('node scripts/window/exit.ts')).toBe(false)
    expect(sessionMarker(SESSION)).toBe(`--session-id ${SESSION}`)
  })

  it('a session is alive when a process carries the adapter marker', () => {
    const marker = clientAdapter().processes.sessionMarker(SESSION)!
    expect(isSessionAlive(SESSION, [{ pid: 1, args: `claude -p ${marker} go` }])).toBe(true)
    expect(isSessionAlive(SESSION, [{ pid: 1, args: 'claude -p --session-id other go' }])).toBe(false)
  })
})

describe('the live working directories of the client', () => {
  it('come from the one lsof search of the worktree port', () => {
    expect(clientAdapter().processes.liveCwds()).toEqual({ kind: 'listed', cwds: ['from the worktree port'] })
  })
})

describe('the isolation command', () => {
  it('of a headless session is the client with the headless flags', () => {
    expect(clientAdapter().processes.isolationCommand()).toEqual(['claude', ...HEADLESS_FLAGS])
    expect(reviewIsolationCommand()).toEqual(clientAdapter().processes.isolationCommand())
  })

  it('of a card session carries the words of the client command before the card permission', () => {
    expect(launchIsolationCommand('claude')).toEqual(['claude', '--permission-mode', 'dontAsk'])
    expect(launchIsolationCommand('/opt/claude --settings /tmp/s.json')).toEqual(['/opt/claude', '--settings', '/tmp/s.json', '--permission-mode', 'dontAsk'])
  })
})
