import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { GhBudgetWindow, ghPort } from '../../ports/gh.js'
import { BUDGET_SPENT_STATUS, ghApi } from '../../ports/github.js'
import { DEFAULT_RETRY_AFTER_S, GitHubFailed, Meter, RateLimited } from '../../ports/meter.js'
import { NetWatch } from '../../ports/netwatch.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const BUDGET_WINDOW_S = 42

function oneCallBudgetPort(): ReturnType<typeof ghPort> {
  return ghPort({ spawn: () => ({ status: 0, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' }), pause: () => {}, budget: new GhBudgetWindow({ calls: 1, windowMs: BUDGET_WINDOW_S * 1000 }, () => 0) })
}

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

  it('a budget refusal from the port backs the nodes off for its retry-after', () => {
    expect(BUDGET_WINDOW_S).not.toBe(DEFAULT_RETRY_AFTER_S)
    const meter = new Meter(ghApi('.', oneCallBudgetPort()), () => 0)
    meter.get('repos/o/r/pulls')
    let refused: unknown
    try {
      meter.get('repos/o/r/pulls')
    }
    catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(RateLimited)
    expect(refused).toMatchObject({ status: BUDGET_SPENT_STATUS, retryAfterSeconds: BUDGET_WINDOW_S })

    const root = mkdtempSync(path.join(tmpdir(), 'bus-meter-budget-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const start = new Date('2026-10-21T00:00:00.000Z')
    const poll = new NetWatch(db, ghApi('.', oneCallBudgetPort()), () => start).poll()
    expect(poll).toMatchObject({ kind: 'skipped', cause: 'rate-limited', until: new Date(start.getTime() + BUDGET_WINDOW_S * 1000).toISOString(), detail: `GitHub answered ${BUDGET_SPENT_STATUS}; retry after ${BUDGET_WINDOW_S} s` })
    db.close()
  })
})
