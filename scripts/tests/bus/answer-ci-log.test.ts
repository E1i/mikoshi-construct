import type { AnswerRequest } from '../../nodes/answer/answerer.js'
import { describe, expect, it } from 'vitest'
import { answerPrompt, failedJobLog } from '../../nodes/answer/answerer.js'
import { CI_LOG_CEILING, ciLogForPrompt, failedJobLinkIn } from '../../nodes/answer/ci-log.js'
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
    expect(log.length).toBeGreaterThan(5 * CI_LOG_CEILING)

    const prompt = answerPrompt(request, '/answers/owner.txt', null, { prepush: [], handoffWrite: null, codeMatrix: null }, undefined, { log, jobLink: JOB_LINK })

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

    expect(failedJobLog(CARD, 'a'.repeat(40), port)).toEqual({ log: FAILURE, jobLink: JOB_LINK })
  })

  it('a failed link read keeps the log and leaves the link unread', () => {
    const port = gh({ '--log-failed': { status: 0, stdout: FAILURE }, 'jobs': { status: 1, stdout: '' }, 'run list': { status: 0, stdout: '[{"databaseId":7}]' } })

    expect(failedJobLog(CARD, 'a'.repeat(40), port)).toEqual({ log: FAILURE, jobLink: null })
  })
})
