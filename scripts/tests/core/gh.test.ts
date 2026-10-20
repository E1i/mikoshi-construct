import type { GhPortOptions, GhSpawned } from '../../core/gh.js'
import { describe, expect, it } from 'vitest'
import { GhBudgetWindow, GhFailed, ghPort, ghRunner, GhTimedOut } from '../../core/gh.js'

const ok = (stdout: string): GhSpawned => ({ status: 0, stdout, stderr: '' })
const http = (code: number): GhSpawned => ({ status: 1, stdout: '', stderr: `gh: Server said no (HTTP ${code})` })
const timedOut: GhSpawned = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
const tls: GhSpawned = { status: 1, stdout: '', stderr: 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout' }

function scripted(runs: GhSpawned[], overrides: Partial<GhPortOptions> = {}) {
  const calls: string[][] = []
  const pauses: number[] = []
  const port = ghPort({ spawn: (_command, args) => {
    calls.push(args)
    return runs.shift() ?? ok('')
  }, pause: ms => pauses.push(ms), budget: new GhBudgetWindow({ calls: 100, windowMs: 1000 }, () => 0), ...overrides })
  return { port, calls, pauses }
}

describe('the gh port', () => {
  it('a 5xx, ETIMEDOUT, TLS or 403 waits and retries, then returns a technical result and never throws', () => {
    for (const transient of [http(502), timedOut, tls, http(403)]) {
      const { port, calls, pauses } = scripted([transient, transient, transient])
      const result = port.call(['pr', 'list'])
      expect(result).toMatchObject({ kind: 'failed', attempts: 3 })
      expect(calls).toHaveLength(3)
      expect(pauses).toEqual([2000, 4000])
    }
    const recovered = scripted([http(503), ok('[]')])
    expect(recovered.port.call(['pr', 'list'])).toEqual({ kind: 'ran', stdout: '[]', attempts: 2 })
    expect(recovered.pauses).toEqual([2000])
  })

  it('a failure that is not transient returns at once, without a retry', () => {
    const { port, calls, pauses } = scripted([http(404)])
    expect(port.call(['pr', 'view', '1'])).toMatchObject({ kind: 'failed', cause: 'failed', attempts: 1 })
    expect(calls).toHaveLength(1)
    expect(pauses).toEqual([])
  })

  it('a spent budget refuses the call without spawning gh, names when it frees, and frees as the window moves on', () => {
    let now = 0
    const { port, calls } = scripted([], { budget: new GhBudgetWindow({ calls: 2, windowMs: 10_000 }, () => now) })
    expect(port.call(['a']).kind).toBe('ran')
    now = 4000
    expect(port.call(['b']).kind).toBe('ran')
    expect(port.call(['c'])).toMatchObject({ kind: 'failed', cause: 'budget', attempts: 0, retryAfterSeconds: 6 })
    expect(calls).toHaveLength(2)
    now = 10_000
    expect(port.call(['d']).kind).toBe('ran')
  })

  it('every port of a process draws on one budget', () => {
    const budget = new GhBudgetWindow({ calls: 2, windowMs: 1000 }, () => 0)
    const first = scripted([], { budget })
    const second = scripted([], { budget, command: 'other-gh' })
    expect(first.port.call(['a']).kind).toBe('ran')
    expect(second.port.call(['b']).kind).toBe('ran')
    expect(first.port.call(['c'])).toMatchObject({ kind: 'failed', cause: 'budget' })
    expect(second.port.call(['d'])).toMatchObject({ kind: 'failed', cause: 'budget' })
  })

  it('the runner adapter keeps its contract: stdout, a timeout that stays expired, a failure carrying stderr', () => {
    const passing = scripted([ok('out')])
    expect(ghRunner(20, 'gh', passing.port)(['x'])).toBe('out')

    const failing = scripted([http(404)])
    const thrown = (() => {
      try {
        ghRunner(20, 'gh', failing.port)(['pr', 'view', '9'])
      }
      catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(GhFailed)
    expect((thrown as GhFailed).stderr).toContain('HTTP 404')

    const timing = scripted([timedOut, timedOut, timedOut])
    const runner = ghRunner(20, 'gh', timing.port)
    expect(() => runner(['x'])).toThrow(GhTimedOut)
    expect(() => runner(['y'])).toThrow(GhTimedOut)
    expect(timing.calls).toHaveLength(3)
  })
})
