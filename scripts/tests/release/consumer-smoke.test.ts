import type { SpawnSyncReturns } from 'node:child_process'
import type { RoleSession, SmokeRole, SmokeSetting, SmokeStep, StepRecord } from '../../release/consumer-smoke.js'
import { describe, expect, it } from 'vitest'
import {
  baseBranchOf,
  CARD_SESSION_ROLE,
  cardBranchOf,
  CLAIMED_CAPABILITIES,
  ClaudeRoleSession,
  recordsOfTranscript,
  runSmoke,
  SMOKE_ROLES,
  SMOKE_STATUS_CONTEXT,
  smokePlan,
  smokeStatus,
} from '../../release/consumer-smoke.js'

const HEAD = '0123456789abcdef0123456789abcdef01234567'

const SETTING: SmokeSetting = { head: HEAD, browserLab: '/opt/construct/bin/browser-lab', url: 'https://example.com', ghRepo: 'o/scratch' }

type Outcome = Pick<StepRecord, 'exit' | 'output'>

class StubSession implements RoleSession {
  readonly asked: { role: SmokeRole, steps: SmokeStep[] }[] = []

  constructor(private readonly outcome: (step: SmokeStep) => Outcome | null = () => ({ exit: 0, output: 'ok' })) {}

  run(role: SmokeRole, steps: SmokeStep[]): StepRecord[] {
    this.asked.push({ role, steps })
    return steps.flatMap((step) => {
      const outcome = this.outcome(step)
      return outcome === null ? [] : [{ ...step, ...outcome }]
    })
  }
}

describe('the consumer smoke runs the first step of every claimed capability in each role', () => {
  it('the consumer smoke records the exit and output of the first step of every claimed capability in each role', () => {
    const session = new StubSession(step => ({ exit: 0, output: `${step.role} ${step.capability} said ok` }))

    const run = runSmoke(HEAD, smokePlan(SETTING), session)

    expect(session.asked.map(asked => asked.role)).toEqual([...SMOKE_ROLES])
    for (const role of SMOKE_ROLES) {
      for (const capability of CLAIMED_CAPABILITIES) {
        const record = run.records.find(entry => entry.role === role && entry.capability === capability)
        expect(record, `${role} ${capability}`).toMatchObject({ exit: 0, output: `${role} ${capability} said ok` })
      }
    }
    const commandOf = (role: SmokeRole, capability: string): string | undefined => run.records.find(entry => entry.role === role && entry.capability === capability)?.command
    for (const role of SMOKE_ROLES) {
      expect(commandOf(role, 'browser-lab')).toBe(`/opt/construct/bin/browser-lab page https://example.com --shot smoke-shots/${role}.png`)
      expect(commandOf(role, 'codex')).toMatch(/^codex exec /)
      expect(commandOf(role, 'gh')).toBe('gh repo view o/scratch --json name')
      expect(commandOf(role, 'git-commit')).toMatch(/^git commit /)
    }
    expect(run.verdict.passed).toBe(true)
    expect(smokeStatus(run)).toMatchObject({ state: 'success', context: SMOKE_STATUS_CONTEXT })
  })

  it('refuses a browser-lab that is not the installed absolute path', () => {
    expect(() => smokePlan({ ...SETTING, browserLab: 'browser-lab' })).toThrow(/installed absolute path/)
  })

  it('records a step the session never returned as not run, and the run is red', () => {
    const run = runSmoke(HEAD, smokePlan(SETTING), new StubSession(step => step.role === 'review' && step.capability === 'gh' ? null : { exit: 0, output: 'ok' }))

    expect(run.records.find(entry => entry.role === 'review' && entry.capability === 'gh')).toMatchObject({ exit: null })
    expect(run.verdict.passed).toBe(false)
    expect(run.verdict.lines.join('\n')).toContain('review: gh did not run')
  })
})

describe('a red smoke names what to fix', () => {
  it('a capability whose first step failed in a role is named with that role in the red verdict', () => {
    const session = new StubSession((step) => {
      if (step.role === 'window' && step.capability === 'codex')
        return { exit: 1, output: 'error: codex is not logged in\nmore' }
      if (step.role === 'answer' && step.capability === 'git-commit')
        return { exit: null, output: 'Permission to use Bash has been denied' }
      return { exit: 0, output: 'ok' }
    })

    const run = runSmoke(HEAD, smokePlan(SETTING), session)

    expect(run.verdict.passed).toBe(false)
    const text = run.verdict.lines.join('\n')
    expect(text).toContain('window: codex exited 1 — error: codex is not logged in')
    expect(text).toContain('answer: git-commit did not run — Permission to use Bash has been denied')
    expect(text).not.toContain('launch:')
    expect(smokeStatus(run)).toEqual({ state: 'failure', context: SMOKE_STATUS_CONTEXT, description: 'red: answer git-commit, window codex' })
  })
})

describe('the card session commits and opens a pull request', () => {
  it('the consumer smoke card session makes a commit and opens a pull request in its card branch', () => {
    const session = new StubSession(step => ({ exit: 0, output: step.capability === 'pull-request' ? 'https://github.com/o/scratch/pull/7' : 'ok' }))

    const run = runSmoke(HEAD, smokePlan(SETTING), session)

    const card = run.records.filter(entry => entry.role === CARD_SESSION_ROLE).map(entry => entry.capability)
    expect(card.indexOf('git-commit')).toBeLessThan(card.indexOf('git-push'))
    expect(card.indexOf('git-push')).toBeLessThan(card.indexOf('pull-request'))
    const branch = cardBranchOf(HEAD, CARD_SESSION_ROLE)
    const recordOf = (capability: string): StepRecord | undefined => run.records.find(entry => entry.role === CARD_SESSION_ROLE && entry.capability === capability)
    expect(recordOf('git-push')).toMatchObject({ exit: 0, command: `git push -u origin ${branch}` })
    expect(recordOf('pull-request')).toMatchObject({ exit: 0, output: 'https://github.com/o/scratch/pull/7' })
    expect(recordOf('pull-request')?.command).toContain(`--base ${baseBranchOf(HEAD)} --head ${branch}`)
    expect(run.records.filter(entry => entry.role !== CARD_SESSION_ROLE && entry.capability === 'pull-request')).toEqual([])
  })

  it('a card session whose commit is refused leaves the pull request red, naming the card role', () => {
    const run = runSmoke(HEAD, smokePlan(SETTING), new StubSession(step => step.role === CARD_SESSION_ROLE && step.capability !== 'browser-lab' && step.capability !== 'codex' && step.capability !== 'gh' ? { exit: 128, output: 'fatal: Unable to create index.lock: Operation not permitted' } : { exit: 0, output: 'ok' }))

    const text = run.verdict.lines.join('\n')
    expect(text).toContain('launch: git-commit exited 128')
    expect(text).toContain('launch: pull-request exited 128')
  })
})

function line(value: unknown): string {
  return JSON.stringify(value)
}

function bashUse(id: string, command: string): string {
  return line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
}

function bashResult(id: string, content: unknown, isError = false): string {
  return line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
}

describe('a live session transcript becomes the step records', () => {
  const steps: SmokeStep[] = smokePlan(SETTING).filter(step => step.role === 'review')

  it('reads the exit and output of each Bash call that ran a planned command', () => {
    const [shot, codex, gh, commit] = steps
    const transcript = [
      line({ type: 'system', subtype: 'init' }),
      bashUse('a', shot!.command),
      bashResult('a', 'saved smoke-shots/review.png'),
      bashUse('b', codex!.command),
      bashResult('b', 'Exit code 2\nnot logged in', true),
      bashUse('c', gh!.command),
      bashResult('c', 'Permission to use Bash has been denied.', true),
      'not json',
    ].join('\n')

    const records = recordsOfTranscript(steps, transcript)

    expect(records.map(record => [record.capability, record.exit])).toEqual([['browser-lab', 0], ['codex', 2], ['gh', null], ['git-commit', null]])
    expect(records[0]!.output).toBe('saved smoke-shots/review.png')
    expect(records[2]!.output).toContain('denied')
    expect(records[3]!.output).toBe('the session never ran this command')
    expect(commit!.role).toBe('review')
  })

  it('launches claude in the role tree with the role settings and the planned commands', () => {
    const calls: { command: string, args: string[], cwd: string }[] = []
    const spawn = (command: string, args: string[], cwd: string): SpawnSyncReturns<string> => {
      calls.push({ command, args, cwd })
      return { pid: 1, output: [], stdout: [bashUse('x', steps[0]!.command), bashResult('x', [{ type: 'text', text: 'shot' }])].join('\n'), stderr: '', status: 0, signal: null }
    }
    const session = new ClaudeRoleSession(role => `/scratch/trees/${role}`, role => role === 'review' ? '{"sandbox":{"enabled":true}}' : null, spawn)

    const records = session.run('review', steps)

    expect(calls[0]!.command).toBe('claude')
    expect(calls[0]!.cwd).toBe('/scratch/trees/review')
    expect(calls[0]!.args.slice(0, 6)).toEqual(['--permission-mode', 'dontAsk', '--setting-sources', 'project,local', '--settings', '{"sandbox":{"enabled":true}}'])
    expect(calls[0]!.args.at(-1)).toContain(steps[0]!.command)
    expect(records[0]).toMatchObject({ exit: 0, output: 'shot' })
  })
})
