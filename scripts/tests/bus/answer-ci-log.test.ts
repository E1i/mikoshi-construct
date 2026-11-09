import type { AnswerRequest } from '../../nodes/answer/answerer.js'
import { describe, expect, it } from 'vitest'
import { windowGateRule } from '../../nodes/answer/answerer.js'
import { answerPrompt } from '../../nodes/answer/duties/index.js'
import { CI_LOG_CEILING, ciLogForPrompt, failedJobLinkIn, GhCiRuns } from '../../ports/ci-reading.js'
import { ghPort } from '../../ports/gh.js'

const JOB_LINK = 'https://github.com/owner/repo/actions/runs/1/job/2'
const PREFIX = 'vitest 2/4\tUNKNOWN STEP\t2026-11-05T10:00:00.1234567Z '
const FAILURE = 'FAIL  scripts/tests/bus/queue.test.ts > the queue > expected 1 to be 2'
const GREEN = ' ✓ scripts/tests/bus/green.test.ts (4 tests) 12ms'
const SETUP = 'Current runner version: \'2.320.0\''
const FILLER = 'compiling a module nobody asked about'
const CARD = { session: 's', worktree: '/tree', branch: 'feat/card-1' }

const request: AnswerRequest = {
  lease: { taskKey: 'answer:1:1', queue: 'answer', cardId: 1, pr: 1, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:worker-1' },
  source: { kind: 'ci', failedChecks: ['vitest 2/4'], events: [], decisions: [] },
  widened: null,
  card: CARD,
}

function logged(...lines: string[]): string {
  return lines.map(line => `${PREFIX}${line}`).join('\n')
}

function logPartOf(prompt: string): string {
  return prompt.slice(prompt.indexOf('The failures and the tail'), prompt.indexOf('Fix every failure it shows.'))
}

describe('the failed-job log the answer prompt carries', () => {
  it('a long log with the failure at the end reaches the prompt under the ceiling', () => {
    const log = logged(...Array.from<string>({ length: 20_000 }).fill(FILLER), FAILURE, 'AssertionError: expected 1 to be 2')
    expect(CI_LOG_CEILING).toBe(20_000)
    expect(log.length).toBeGreaterThan(5 * CI_LOG_CEILING)

    const prompt = answerPrompt(request, null, windowGateRule(request.card, { prepush: [], handoffWrite: null, codeMatrix: null }, '/answers/owner.txt'), undefined, { log, jobLink: JOB_LINK })

    expect(prompt).toContain(FAILURE)
    expect(prompt).toContain('AssertionError: expected 1 to be 2')
    expect(ciLogForPrompt({ log, jobLink: JOB_LINK }).length).toBeLessThanOrEqual(CI_LOG_CEILING)
    expect(logPartOf(prompt).length).toBeLessThan(CI_LOG_CEILING + 100)
  })

  it('the text is clean: ANSI, green lines and runner setup are dropped and the cut line names the count and the job link', () => {
    const log = logged(`##[group]Runner Image`, SETUP, GREEN, `\u001B[31m${FAILURE}\u001B[39m`, 'the last line')

    const text = ciLogForPrompt({ log, jobLink: JOB_LINK })

    expect(text).not.toContain('\u001B')
    expect(text).not.toContain(GREEN.trim())
    expect(text).not.toContain(SETUP)
    expect(text).not.toContain('##[group]')
    expect(text).toContain(FAILURE)
    const dropped = [`##[group]Runner Image`, SETUP, GREEN].reduce((sum, line) => sum + PREFIX.length + line.length + 1, 0)
    expect(text.split('\n').at(-1)).toBe(`cut: ${dropped} characters, full log: ${JOB_LINK}`)
  })

  it('a failure far before the tail keeps its block and drops what lies between', () => {
    const log = logged('context before', FAILURE, 'the stack under it', ...Array.from<string>({ length: 5_000 }).fill(FILLER), 'the last line')

    const text = ciLogForPrompt({ log, jobLink: JOB_LINK })

    expect(text).toContain('context before')
    expect(text).toContain(FAILURE)
    expect(text).toContain('the stack under it')
    expect(text).toContain('the last line')
    expect(text.length).toBeLessThanOrEqual(CI_LOG_CEILING)
  })

  it('many failures stay under the ceiling and keep the tail', () => {
    const log = logged(...Array.from<string>({ length: 5_000 }).fill(FAILURE), 'the last line')

    const text = ciLogForPrompt({ log, jobLink: JOB_LINK })

    expect(text.length).toBeLessThanOrEqual(CI_LOG_CEILING)
    expect(text).toContain(FAILURE)
    expect(text).toContain('the last line')
  })

  it('a log that fits and carries no marker keeps its tail', () => {
    const log = logged('the runner lost its connection')

    expect(ciLogForPrompt({ log, jobLink: JOB_LINK })).toBe(`${log}\ncut: 0 characters, full log: ${JOB_LINK}`)
  })

  it('a log of nothing but green and setup lines keeps its tail, never nothing', () => {
    const log = logged(GREEN, SETUP)

    expect(ciLogForPrompt({ log, jobLink: JOB_LINK })).toContain(SETUP)
  })

  it('a job or step named after a failure is not a marker', () => {
    const named = 'Fail fast\tError check\t2026-11-05T10:00:00.1234567Z '
    const log = [`${named}a line nobody needs`, ...Array.from<string>({ length: 3_000 }).fill(`${named}${FILLER}`)].join('\n')

    expect(ciLogForPrompt({ log, jobLink: JOB_LINK })).not.toContain('a line nobody needs')
  })

  it('a job link the bus could not read is named as unread in the line', () => {
    expect(ciLogForPrompt({ log: FAILURE, jobLink: null })).toBe(`${FAILURE}\ncut: 0 characters, full log: the job link is unread`)
  })

  it('a failure block holds two lines before the marker and twenty after it, and no more', () => {
    const numbered = (name: string, count: number): string[] => Array.from({ length: count }, (_, at) => `${name} ${at + 1}.`)
    const log = logged(...numbered('before', 3).reverse(), FAILURE, ...numbered('after', 21), ...Array.from<string>({ length: 5_000 }).fill(FILLER))

    const text = ciLogForPrompt({ log, jobLink: JOB_LINK })

    expect(text).toContain('before 2.')
    expect(text).not.toContain('before 3.')
    expect(text).toContain('after 20.')
    expect(text).not.toContain('after 21.')
  })

  it.each([
    ['✓ scripts/tests/one.test.ts (4 tests) 12ms'],
    ['✔ scripts/tests/two.test.ts (4 tests) 12ms'],
    ['√ scripts/tests/three.test.ts (4 tests) 12ms'],
    ['PASS scripts/tests/four.test.ts'],
    ['   ✓ an indented passing test 3ms'],
    ['✓ a passing test that names FAIL and Error 3ms'],
  ])('the green line %s is dropped from the block and the tail', (line) => {
    const text = ciLogForPrompt({ log: logged(FAILURE, line), jobLink: JOB_LINK })

    expect(text).toContain(FAILURE)
    expect(text).not.toContain(line)
  })

  it.each([
    ['##[group]Runner Image'],
    ['##[endgroup]'],
    ['[command]/usr/bin/git version'],
    ['Current runner version: \'2.320.0\''],
    ['Runner name: \'GitHub Actions 7\''],
    ['Runner group name: \'GitHub Actions\''],
    ['Runner Image Provisioner'],
    ['Machine name: \'runnervm\''],
    ['Hosted Compute Agent'],
    ['Operating System'],
    ['Image: ubuntu-24.04'],
    ['Image Release: https://example.test/release'],
    ['Version: 20261101.1'],
    ['Included Software: https://example.test/software'],
    ['GITHUB_TOKEN Permissions'],
    ['Secret source: Actions'],
    ['Prepare workflow directory'],
    ['Prepare all required actions'],
    ['Getting action download info'],
    ['Download action repository \'actions/checkout@v4\' (SHA:abc)'],
    ['Download immutable action package \'actions/checkout@v4\''],
    ['Complete job name: vitest 2/4'],
    ['Syncing repository: owner/repo'],
    ['Getting Git version info'],
    ['Temporarily overriding HOME=\'/home/runner/work/_temp/x\''],
    ['Adding repository directory to the temporary git global config as a safe directory'],
    ['Deleting the contents of \'/home/runner/work/repo\''],
    ['Initializing the repository'],
    ['Disabling automatic garbage collection'],
    ['Setting up auth'],
    ['Fetching the repository'],
    ['Determining the checkout info'],
    ['Checking out the ref'],
  ])('the runner setup line %s is dropped from the block and the tail', (line) => {
    const text = ciLogForPrompt({ log: logged(FAILURE, line), jobLink: JOB_LINK })

    expect(text).toContain(FAILURE)
    expect(text).not.toContain(line)
  })

  it.each([
    ['FAIL scripts/tests/one.test.ts'],
    ['FAILED scripts/tests/two.test.ts'],
    ['ERROR the build broke'],
    ['Error: the build broke'],
    ['TypeError: x is not a function'],
    ['##[error]Process completed with exit code 1.'],
  ])('the marker in %s keeps its line far before the tail', (line) => {
    const log = logged(line, ...Array.from<string>({ length: 5_000 }).fill(FILLER))

    expect(ciLogForPrompt({ log, jobLink: JOB_LINK })).toContain(line)
  })

  it.each([
    ['a failure of the network is not named here'],
    ['two errors were expected and handled'],
    ['Errors are counted below'],
  ])('%s is no marker and stays out far before the tail', (line) => {
    const log = logged(line, ...Array.from<string>({ length: 5_000 }).fill(FILLER))

    expect(ciLogForPrompt({ log, jobLink: JOB_LINK })).not.toContain(line)
  })

  it('a log with no marker carries its tail up to the tail ceiling and not the whole ceiling', () => {
    const log = logged(...Array.from<string>({ length: 5_000 }).fill(FILLER), 'the last line')

    const carried = ciLogForPrompt({ log, jobLink: JOB_LINK }).split('\n').slice(0, -1).join('\n')

    expect(carried.endsWith('the last line')).toBe(true)
    expect(carried.length).toBeGreaterThan(4_900)
    expect(carried.length).toBeLessThanOrEqual(5_000)
  })

  it('one line far over the ceiling keeps its end', () => {
    const log = `${'x'.repeat(100_000)} FAIL at the end`

    const text = ciLogForPrompt({ log, jobLink: JOB_LINK })

    expect(text).toContain('FAIL at the end')
    expect(text.length).toBeLessThanOrEqual(CI_LOG_CEILING)
  })

  it('a log full of failures fills the ceiling and the count is what it left out', () => {
    const log = logged(...Array.from<string>({ length: 5_000 }).fill(FAILURE))

    const text = ciLogForPrompt({ log, jobLink: JOB_LINK })
    const lines = text.split('\n')
    const carried = lines.slice(0, -1).join('\n')

    expect(text.length).toBeGreaterThan(CI_LOG_CEILING - 3)
    expect(text.length).toBeLessThanOrEqual(CI_LOG_CEILING)
    expect(lines.at(-1)).toBe(`cut: ${log.length - carried.length} characters, full log: ${JOB_LINK}`)
  })
})

describe('the failed job and its link', () => {
  it('the link is the url of the job that failed', () => {
    const jobs = JSON.stringify({ jobs: [{ conclusion: 'success', url: 'https://green' }, { conclusion: 'failure', url: JOB_LINK }] })

    expect(failedJobLinkIn(jobs)).toBe(JOB_LINK)
  })

  it.each([['not json'], ['{"jobs":[{"conclusion":"success","url":"https://green"}]}'], ['{}']])('no link is read from %s', (jobs) => {
    expect(failedJobLinkIn(jobs)).toBeNull()
  })

  function gh(answers: Record<string, { status: number, stdout: string }>): ReturnType<typeof ghPort> {
    const spawn = (_command: string, args: string[]): { status: number, stdout: string, stderr: string } => {
      const answer = answers[args.at(-1)!] ?? answers[args.slice(0, 2).join(' ')]!
      return { ...answer, stderr: '' }
    }
    return ghPort({ spawn, environment: {}, attempts: 1 })
  }

  it('failedJobLog reads the log and the link through the same port', () => {
    const port = gh({ '--log-failed': { status: 0, stdout: FAILURE }, 'jobs': { status: 0, stdout: JSON.stringify({ jobs: [{ conclusion: 'failure', url: JOB_LINK }] }) }, 'run list': { status: 0, stdout: '[{"databaseId":7}]' } })

    expect(new GhCiRuns(port).failureLogOn('a'.repeat(40), CARD.worktree)).toEqual({ log: FAILURE, jobLink: JOB_LINK })
  })

  it('a failed link read keeps the log and leaves the link unread', () => {
    const port = gh({ '--log-failed': { status: 0, stdout: FAILURE }, 'jobs': { status: 1, stdout: '' }, 'run list': { status: 0, stdout: '[{"databaseId":7}]' } })

    expect(new GhCiRuns(port).failureLogOn('a'.repeat(40), CARD.worktree)).toEqual({ log: FAILURE, jobLink: null })
  })
})
