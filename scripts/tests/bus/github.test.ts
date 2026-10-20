import type { GhSpawned } from '../../core/gh.js'
import { describe, expect, it } from 'vitest'
import { ghApi } from '../../bus/github.js'
import { ghPort } from '../../core/gh.js'

const included = (code: number, body: string): GhSpawned => ({ status: code === 200 ? 0 : 1, stdout: `HTTP/2.0 ${code} X\r\nX-Ratelimit-Remaining: 9\r\n\r\n${body}\n`, stderr: code === 200 ? '' : `gh: no (HTTP ${code})` })

function apiOver(runs: GhSpawned[]) {
  const calls: string[][] = []
  const port = ghPort({ spawn: (_command, args) => {
    calls.push(args)
    return runs.shift()!
  }, pause: () => {}, now: () => 0 })
  return { gitHub: ghApi('.', port), calls }
}

describe('the bus reads GitHub through the gh port', () => {
  it('a 5xx is retried by the port and the answer that follows is parsed', () => {
    const { gitHub, calls } = apiOver([included(502, '{}'), included(200, '{"ok":true}')])
    expect(gitHub('repos/o/r/pulls')).toEqual({ status: 200, headers: { 'x-ratelimit-remaining': '9' }, body: { ok: true } })
    expect(calls).toEqual([['api', '--include', '--method', 'GET', 'repos/o/r/pulls'], ['api', '--include', '--method', 'GET', 'repos/o/r/pulls']])
  })

  it('a response that is not transient comes back as the response, not an exception', () => {
    const { gitHub, calls } = apiOver([included(404, '{"message":"Not Found"}')])
    expect(gitHub('repos/o/r/pulls/9').status).toBe(404)
    expect(calls).toHaveLength(1)
  })

  it('a call that printed no response names the endpoint and the reason', () => {
    const { gitHub } = apiOver([{ status: 1, stdout: '', stderr: 'could not resolve host' }])
    expect(() => gitHub('repos/o/r')).toThrow('gh api repos/o/r: gh api --include --method GET repos/o/r: could not resolve host')
  })
})
