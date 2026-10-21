import { describe, expect, it } from 'vitest'
import { ghApi } from '../../bus/github.js'
import { GitHubFailed, Meter } from '../../bus/meter.js'
import { GhBudgetWindow, ghPort } from '../../core/gh.js'

function meterOverFailingGh(stderr: string): Meter {
  const port = ghPort({ spawn: () => ({ status: 1, stdout: '', stderr }), pause: () => {}, budget: new GhBudgetWindow({ calls: 100, windowMs: 1000 }, () => 0) })
  return new Meter(ghApi('.', port), () => 0)
}

describe('the meter over the gh port', () => {
  it('a 599 from the port keeps its body.message as the cause', () => {
    const meter = meterOverFailingGh('could not resolve host')
    let failed: unknown
    try {
      meter.get('repos/o/r/pulls')
    }
    catch (error) {
      failed = error
    }
    expect(failed).toBeInstanceOf(GitHubFailed)
    expect((failed as GitHubFailed).status).toBe(599)
    expect((failed as GitHubFailed).cause).toBe('gh api repos/o/r/pulls: gh api --include --method GET repos/o/r/pulls: could not resolve host')
  })
})
