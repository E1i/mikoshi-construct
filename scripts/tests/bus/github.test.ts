import type { GhSpawned } from '../../core/gh.js'
import { describe, expect, it } from 'vitest'
import { BUDGET_SPENT_STATUS, ghApi, ghApiPut, NO_ANSWER_STATUS } from '../../bus/github.js'
import { GhBudgetWindow, ghPort } from '../../core/gh.js'

const included = (code: number, body: string): GhSpawned => ({ status: code === 200 ? 0 : 1, stdout: `HTTP/2.0 ${code} X\r\nX-Ratelimit-Remaining: 9\r\n\r\n${body}\n`, stderr: code === 200 ? '' : `gh: no (HTTP ${code})` })

function apiOver(runs: GhSpawned[], budget = new GhBudgetWindow({ calls: 100, windowMs: 1000 }, () => 0)) {
  const calls: string[][] = []
  const port = ghPort({ spawn: (_command, args) => {
    calls.push(args)
    return runs.shift() ?? included(200, '{}')
  }, pause: () => {}, budget })
  return { gitHub: ghApi('.', port), put: ghApiPut('.', port), calls }
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

  it('a call that got no HTTP answer is a technical response naming the endpoint and the reason, never an exception', () => {
    const { gitHub } = apiOver([{ status: 1, stdout: '', stderr: 'could not resolve host' }])
    expect(gitHub('repos/o/r')).toEqual({ status: NO_ANSWER_STATUS, headers: {}, body: { message: 'gh api repos/o/r: gh api --include --method GET repos/o/r: could not resolve host' } })
    const garbled = apiOver([{ status: 0, stdout: 'not http', stderr: '' }])
    expect(garbled.gitHub('repos/o/r').status).toBe(NO_ANSWER_STATUS)
  })

  it('a read and a write of one process draw on one budget, and a spent budget answers as a rate limit with its retry-after', () => {
    const { gitHub, put, calls } = apiOver([], new GhBudgetWindow({ calls: 2, windowMs: 60_000 }, () => 0))
    expect(gitHub('repos/o/r/pulls').status).toBe(200)
    expect(put('repos/o/r/pulls/1/merge', { sha: 'abc' }).status).toBe(200)
    expect(gitHub('repos/o/r/pulls')).toMatchObject({ status: BUDGET_SPENT_STATUS, headers: { 'retry-after': '60' } })
    expect(calls).toHaveLength(2)
  })
})
