import type { BoardCheck, CiCommandRun, EndpointReader } from '../../../src/commands/ci/state.js'
import { describe, expect, it } from 'vitest'
import { readPrs } from '../../../src/commands/board/prs.js'
import { ciOf, ciOfChecks, ciOfPullRequest, commitCi, failedJobLog, hasApprovedRun, rollupFault, rollupFields } from '../../../src/commands/ci/state.js'

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'
const EARLIER = '2026-11-07T10:00:00Z'
const LATER = '2026-11-07T11:00:00Z'

function readerOf(body: unknown): { reader: EndpointReader, endpoints: string[] } {
  const endpoints: string[] = []
  return {
    endpoints,
    reader: {
      get: (endpoint) => {
        endpoints.push(endpoint)
        return body
      },
    },
  }
}

const BOARD_CHECKS: readonly [string, BoardCheck[], 'none' | 'red' | 'green' | 'pending'][] = [
  ['no checks', [], 'none'],
  ['every check run passed', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }], 'green'],
  ['a check run failed', [{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }], 'red'],
  ['a check run still running', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }], 'pending'],
  ['a status context failed', [{ context: 'ext', state: 'ERROR' }], 'red'],
  ['a status context unfinished', [{ context: 'ext', state: 'PENDING' }], 'pending'],
  ['a status context passed', [{ context: 'ext', state: 'SUCCESS' }], 'green'],
]

describe('the board reading of a pull request', () => {
  it('turns its checks into none, red, green or pending', () => {
    for (const [label, checks, state] of BOARD_CHECKS)
      expect(ciOfChecks(checks).state, label).toBe(state)
  })

  it('carries the latest valid completion time', () => {
    const checks = [{ status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: LATER }, { status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: EARLIER }, { status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: 'not a time' }]

    expect(ciOfPullRequest({ statusCheckRollup: checks })).toEqual({ state: 'green', completedAt: LATER })
  })

  it('names a rollup that is not a list of checks and passes a missing one', () => {
    expect(rollupFault({ statusCheckRollup: 'x' }, 2)).toBe('entry 3 has a statusCheckRollup that is not a list of checks')
    expect(rollupFault({ statusCheckRollup: [[]] }, 0)).toBe('entry 1 has a statusCheckRollup that is not a list of checks')
    expect(rollupFault({}, 0)).toBeUndefined()
    expect(rollupFields({ statusCheckRollup: null })).toEqual({ statusCheckRollup: [] })
  })

  it('still reads the JSON a person hands it', () => {
    const entry = { number: 1, title: 't', state: 'OPEN', createdAt: EARLIER }
    const read = readPrs('-', () => JSON.stringify([entry]))
    const refused = readPrs('-', () => JSON.stringify([{ ...entry, statusCheckRollup: 'x' }]))

    expect(read).toEqual({ status: 'read', file: '-', prs: [{ ...entry, closedAt: null, mergedAt: null, statusCheckRollup: [] }] })
    expect(refused).toEqual({ status: 'unreadable', file: '-', reason: 'entry 1 has a statusCheckRollup that is not a list of checks' })
  })
})

describe('the reading through an injected reader', () => {
  it('reads a commit through whatever answers an endpoint', () => {
    const { reader, endpoints } = readerOf({ check_runs: [{ name: 'required', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'failure' }] })

    expect(commitCi(reader, HEAD)).toEqual({ state: 'red', failedChecks: ['lint'] })
    expect(ciOf(reader, HEAD)).toBe('red')
    expect(endpoints[0]).toBe(`repos/{owner}/{repo}/commits/${HEAD}/check-runs?per_page=100`)
  })

  it('takes a run that awaits approval as no approved run', () => {
    expect(hasApprovedRun(readerOf({ workflow_runs: [{ conclusion: 'action_required' }] }).reader, HEAD)).toBe(false)
    expect(hasApprovedRun(readerOf({ workflow_runs: [{ conclusion: 'success' }] }).reader, HEAD)).toBe(true)
    expect(hasApprovedRun(readerOf({}).reader, undefined)).toBe(false)
  })

  it('reads a failed job log through whatever runs a command', () => {
    const answers: CiCommandRun[] = [{ kind: 'ran', stdout: '[{"databaseId":7}]' }, { kind: 'ran', stdout: 'FAIL x' }, { kind: 'failed' }]
    const asked: string[][] = []
    const run = (args: string[]): CiCommandRun => {
      asked.push(args)
      return answers.shift()!
    }

    expect(failedJobLog(run, HEAD)).toEqual({ log: 'FAIL x', jobLink: null })
    expect(asked).toEqual([
      ['run', 'list', '--commit', HEAD, '--status', 'failure', '--json', 'databaseId', '--limit', '1'],
      ['run', 'view', '7', '--log-failed'],
      ['run', 'view', '7', '--json', 'jobs'],
    ])
    expect(failedJobLog(() => ({ kind: 'failed' }), HEAD)).toBeNull()
    expect(failedJobLog(() => ({ kind: 'ran', stdout: '[]' }), HEAD)).toBeNull()
    expect(failedJobLog(() => ({ kind: 'ran', stdout: 'not json' }), HEAD)).toBeNull()
  })
})
