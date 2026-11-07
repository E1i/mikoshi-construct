import type { CiState, RollupCheck } from '../../ports/ci-reading.js'
import type { GhSpawned, PullRequest } from '../../ports/gh.js'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { CI_LOG_CEILING, ciFieldsOfObservation, ciLogForPrompt, ciWord, GhCiRuns, GitHubCommitCi, InMemoryCi } from '../../ports/ci-reading.js'
import { GhBudgetWindow, ghPort, REQUIRED_CHECK, SECRET_SCAN_CHECK } from '../../ports/gh.js'
import { Meter } from '../../ports/meter.js'

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'
const SHORT = HEAD.slice(0, 7)
const PR: PullRequest = { number: 7, headRefName: 'feat/x', headRefOid: HEAD, state: 'OPEN', mergedAt: null, mergeCommit: null }
const RUN = { repository: 'owner/repo', runId: '42' }
const BUDGET = new GhBudgetWindow({ calls: 100_000, windowMs: 1000 }, () => 0)

function ghAnswering(...answers: GhSpawned[]): { port: ReturnType<typeof ghPort>, calls: string[][] } {
  const calls: string[][] = []
  const port = ghPort({
    spawn: (_command, args) => {
      calls.push(args)
      return answers.shift() ?? { status: 0, stdout: '', stderr: '' }
    },
    environment: {},
    attempts: 1,
    budget: BUDGET,
  })
  return { port, calls }
}

function meterAnswering(body: unknown): { meter: Meter, endpoints: string[] } {
  const endpoints: string[] = []
  const meter = new Meter((endpoint) => {
    endpoints.push(endpoint)
    return { status: 200, headers: {}, body }
  }, () => 0)
  return { meter, endpoints }
}

const ROLLUPS: readonly [string, RollupCheck[], CiState][] = [
  ['no checks', [], 'none'],
  ['the required check not reported', [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }], 'pending'],
  ['the required check in progress', [{ name: REQUIRED_CHECK, status: 'IN_PROGRESS', conclusion: '' }], 'pending'],
  ['the required check failed', [{ name: REQUIRED_CHECK, status: 'COMPLETED', conclusion: 'FAILURE' }], 'red'],
  ['the required check green', [{ name: REQUIRED_CHECK, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-07T10:00:00Z' }], 'green'],
  ['the secret scan still running', [{ name: REQUIRED_CHECK, status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: SECRET_SCAN_CHECK, status: 'QUEUED', conclusion: '' }], 'pending'],
  ['the secret scan failed', [{ name: REQUIRED_CHECK, status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: SECRET_SCAN_CHECK, status: 'COMPLETED', conclusion: 'FAILURE' }], 'red'],
]

describe('the two adapters of the CI reading', () => {
  it('the in-memory adapter answers the same state as the gh adapter for one rollup', () => {
    for (const [label, checks, state] of ROLLUPS) {
      const { port } = ghAnswering({ status: 0, stdout: JSON.stringify({ headRefOid: HEAD, statusCheckRollup: checks, files: [{ path: 'a.ts' }] }), stderr: '' })
      const overGh = new GhCiRuns(port).pullRequest(PR, 'owner/repo')
      const inMemory = new InMemoryCi({ rollups: { [PR.number]: checks } }).pullRequest(PR)

      expect(overGh.ci.state, label).toBe(state)
      expect(inMemory.ci, label).toEqual(overGh.ci)
      expect(overGh.files, label).toEqual(['a.ts'])
    }
  })

  it('the in-memory adapter answers the same state as the metered adapter for one commit', () => {
    const runs = [{ name: 'required', status: 'completed', conclusion: 'failure' }, { name: 'vitest 1/4', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }]
    const metered = new GitHubCommitCi(meterAnswering({ check_runs: runs }).meter).onCommit(HEAD)

    expect(metered).toEqual({ state: 'red', failedChecks: ['vitest 1/4'] })
    expect(new InMemoryCi({ commits: { [HEAD]: runs } }).onCommit(HEAD)).toEqual(metered)
  })

  it('both name an approved run the same way', () => {
    const { meter, endpoints } = meterAnswering({ workflow_runs: [{ conclusion: 'action_required' }, { conclusion: null }] })

    expect(new GitHubCommitCi(meter).approvedRunOn(HEAD)).toBe(true)
    expect(endpoints).toEqual([`repos/{owner}/{repo}/actions/runs?head_sha=${HEAD}&per_page=100`])
    expect(new GitHubCommitCi(meterAnswering({ workflow_runs: [{ conclusion: 'action_required' }] }).meter).approvedRunOn(HEAD)).toBe(false)
    expect(new GitHubCommitCi(meter).approvedRunOn(undefined)).toBe(false)
    expect(new InMemoryCi({ approvedHeads: [HEAD] }).approvedRunOn(HEAD)).toBe(true)
    expect(new InMemoryCi().approvedRunOn(undefined)).toBe(false)
  })

  it('a pull request the gh adapter cannot read is unknown, and a timeout names itself', () => {
    const refused = new GhCiRuns(ghAnswering({ status: 1, stdout: '', stderr: 'boom' }).port).pullRequest(PR, 'owner/repo')
    expect(refused).toEqual({ ci: { state: 'unknown', text: 'UNKNOWN (missing: checks; the gh query failed)', head: SHORT }, files: undefined })

    const timedOut = new GhCiRuns(ghPort({ spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('late'), { code: 'ETIMEDOUT' }) }), environment: {}, attempts: 1, budget: BUDGET })).pullRequest(PR, 'owner/repo')
    expect(timedOut.ci.text).toContain('timed out')
  })

  it('the runs on main and their jobs read the same over both', () => {
    const runs = [{ databaseId: 1, headSha: HEAD }]
    const jobs = [{ name: 'vitest 1/2', conclusion: 'success', startedAt: 'a', completedAt: 'b' }]
    const { port, calls } = ghAnswering({ status: 0, stdout: JSON.stringify(runs), stderr: '' }, { status: 0, stdout: JSON.stringify({ jobs }), stderr: '' })
    const overGh = new GhCiRuns(port)
    const inMemory = new InMemoryCi({ runsOnMain: runs, jobs: { 1: jobs } })

    expect(overGh.successfulRunsOnMain(60)).toEqual(inMemory.successfulRunsOnMain(60))
    expect(overGh.jobsOfRun(1)).toEqual(inMemory.jobsOfRun(1))
    expect(calls).toEqual([
      ['run', 'list', '--workflow', 'CI', '--branch', 'main', '--event', 'push', '--status', 'success', '--limit', '60', '--json', 'databaseId,headSha'],
      ['run', 'view', '1', '--json', 'jobs'],
    ])
  })

  it('an artifact and a cancellation read the same over both', () => {
    const { port, calls } = ghAnswering({ status: 0, stdout: '{"total_count":1}', stderr: '' })
    const overGh = new GhCiRuns(port)
    const inMemory = new InMemoryCi({ artifacts: { 42: ['stage'] } })

    expect(overGh.artifactsNamed(RUN, 'stage')).toEqual(inMemory.artifactsNamed(RUN, 'stage'))
    expect(overGh.downloadArtifact(42, { name: 'stage', dir: 'out' })).toEqual(inMemory.downloadArtifact(42, { name: 'stage', dir: 'out' }))
    expect(overGh.cancel(RUN)).toBe(inMemory.cancel(RUN))
    expect(calls.slice(1)).toEqual([['run', 'download', '42', '--name', 'stage', '--dir', 'out'], ['run', 'cancel', '42', '--repo', 'owner/repo']])
    expect(inMemory.cancelled).toEqual([RUN])
    expect(inMemory.downloadArtifact(42, { name: 'absent', dir: 'out' })).toEqual({ done: false, reason: 'no artifact absent on run 42' })
  })

  it('the in-memory adapter holds a failed job log per head', () => {
    const log = { log: 'FAIL x', jobLink: null }
    const ci = new InMemoryCi({ failedLogs: { [HEAD]: log } })

    expect(ci.failureLogOn(HEAD)).toEqual(log)
    expect(ci.failureLogOn('other')).toBeNull()
  })

  it('an observation carries the CI word, and the failed checks only when there are some, in the order its digest was taken', () => {
    expect(JSON.stringify(ciFieldsOfObservation({ state: 'green', failedChecks: [] }))).toBe('{"ci":"green"}')
    expect(JSON.stringify(ciFieldsOfObservation({ state: 'red', failedChecks: ['vitest 1/4'] }))).toBe('{"ci":"red","failed_checks":["vitest 1/4"]}')
  })

  it('a CI word a record carries reads as that word and anything else as no reading', () => {
    expect(['pending', 'green', 'red'].map(ciWord)).toEqual(['pending', 'green', 'red'])
    expect([null, undefined, 'success', 3].map(ciWord)).toEqual([null, null, null, null])
  })
})

describe('a long failed-job log', () => {
  const PREFIX = 'vitest 2/4\tUNKNOWN STEP\t2026-11-05T10:00:00.1234567Z '
  const REAL_FAILURE = 'FAIL  scripts/tests/bus/queue.test.ts > the queue > expected 1 to be 2'
  const FILLER = 'compiling a module nobody asked about'
  const logged = (lines: readonly string[]): string => lines.map(line => `${PREFIX}${line}`).join('\n')
  const fill = (count: number, line = FILLER): string[] => Array.from<string>({ length: count }).fill(line)

  it('a log longer than the bound keeps its failure block', () => {
    const noisyMarkers = fill(2_000, 'ERROR a retried request that later passed')
    const log = logged([...noisyMarkers, ...fill(100), 'context before', REAL_FAILURE, 'the stack under it', ...fill(5_000), 'the last line'])

    const text = ciLogForPrompt({ log, jobLink: null })

    expect(log.length).toBeGreaterThan(5 * CI_LOG_CEILING)
    expect(text.length).toBeLessThanOrEqual(CI_LOG_CEILING)
    expect(text).toContain('context before')
    expect(text).toContain(REAL_FAILURE)
    expect(text).toContain('the stack under it')
    expect(text).toContain('the last line')
    expect(text).toContain('ERROR a retried request')
  })

  it('kept blocks stay in the order of the log', () => {
    const log = logged(['ERROR the first', ...fill(100), 'ERROR the second', ...fill(5_000), 'the last line'])

    const text = ciLogForPrompt({ log, jobLink: null })

    expect(text.indexOf('ERROR the first')).toBeLessThan(text.indexOf('ERROR the second'))
    expect(text.indexOf('ERROR the second')).toBeLessThan(text.indexOf('the last line'))
  })

  it('a gh output over a mebibyte reads whole', () => {
    const bytes = 2 * 1024 * 1024
    const port = ghPort({ command: process.execPath, environment: {}, attempts: 1, budget: BUDGET })

    const read = port.call(['-e', `process.stdout.write('x'.repeat(${bytes}))`])

    expect(read.kind === 'ran' && read.stdout.length).toBe(bytes)
  })
})
