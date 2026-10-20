import type { GhPortOptions, GhSpawned } from '../../core/gh.js'
import { describe, expect, it } from 'vitest'
import { GhFailed, ghPort, ghRunner, GhTimedOut } from '../../core/gh.js'

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
  }, pause: ms => pauses.push(ms), now: () => 0, ...overrides })
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

  it('a spent budget refuses the call without spawning gh, until the window moves on', () => {
    let now = 0
    const { port, calls } = scripted([], { budget: { calls: 2, windowMs: 1000 }, now: () => now })
    expect(port.call(['a']).kind).toBe('ran')
    expect(port.call(['b']).kind).toBe('ran')
    expect(port.call(['c'])).toMatchObject({ kind: 'failed', cause: 'budget', attempts: 0 })
    expect(calls).toHaveLength(2)
    now = 1000
    expect(port.call(['d']).kind).toBe('ran')
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
