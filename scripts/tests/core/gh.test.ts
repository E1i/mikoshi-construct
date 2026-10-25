import type { GhPortOptions, GhSpawned } from '../../ports/gh.js'
import { readdirSync } from 'node:fs'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { execGh, GH_TIMEOUT_SECONDS, GhBudgetWindow, GhFailed, ghPort, ghRunner, GhTimedOut, readGhJson, stdoutOrThrow } from '../../ports/gh.js'

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

  it('a gh api call from a test fails at once without credentials', () => {
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
    expect(readdirSync(process.env.GH_CONFIG_DIR!)).toEqual([])
    const started = Date.now()
    expect(ghPort().call(['api', 'user'])).toMatchObject({ kind: 'failed', cause: 'failed', attempts: 1 })
    expect(Date.now() - started).toBeLessThan(GH_TIMEOUT_SECONDS * 1000)
  })

  it('ghRunner and execGh return a technical result on a failed or timed-out call and never throw', () => {
    const passing = scripted([ok('out')])
    expect(ghRunner(20, 'gh', passing.port)(['x'])).toEqual({ kind: 'ran', stdout: 'out', attempts: 1 })

    const failing = scripted([http(404)])
    expect(() => ghRunner(20, 'gh', failing.port)(['pr', 'view', '9'])).not.toThrow()
    expect(ghRunner(20, 'gh', scripted([http(404)]).port)(['pr', 'view', '9'])).toMatchObject({ kind: 'failed', cause: 'failed', stderr: expect.stringContaining('HTTP 404') })

    const timing = scripted([timedOut, timedOut, timedOut])
    const runner = ghRunner(20, 'gh', timing.port)
    const first = runner(['x'])
    expect(first).toMatchObject({ kind: 'failed', cause: 'timeout', reason: 'gh timed out after 20 s' })
    expect(runner(['y'])).toBe(first)
    expect(timing.calls).toHaveLength(3)

    expect(execGh(['api', 'user'])).toMatchObject({ kind: 'failed', cause: 'failed' })
  })

  it('stdoutOrThrow keeps the string contract for the modules that still read gh as a string', () => {
    expect(stdoutOrThrow(ghRunner(20, 'gh', scripted([ok('out')]).port))(['x'])).toBe('out')
    const thrown = (() => {
      try {
        stdoutOrThrow(ghRunner(20, 'gh', scripted([http(404)]).port))(['pr', 'view', '9'])
      }
      catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(GhFailed)
    expect(thrown).not.toBeInstanceOf(GhTimedOut)
    expect((thrown as GhFailed).stderr).toContain('HTTP 404')
    expect(() => stdoutOrThrow(ghRunner(20, 'gh', scripted([timedOut, timedOut, timedOut]).port))(['x'])).toThrow(GhTimedOut)
  })

  it('readGhJson reads stdout as JSON, and a failed call or an unparsable stdout is a failed read', () => {
    expect(readGhJson(ghRunner(20, 'gh', scripted([ok('[1]')]).port), ['x'])).toEqual({ kind: 'read', value: [1] })
    expect(readGhJson(ghRunner(20, 'gh', scripted([http(404)]).port), ['x'])).toMatchObject({ kind: 'failed', cause: 'failed', reason: expect.stringContaining('HTTP 404') })
    expect(readGhJson(ghRunner(20, 'gh', scripted([ok('not json')]).port), ['x'])).toMatchObject({ kind: 'failed', cause: 'unparsed' })
  })
})
