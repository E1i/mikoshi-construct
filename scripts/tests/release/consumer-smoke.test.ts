import type { SpawnSyncReturns } from 'node:child_process'
import type { Invocation, Refusal, SessionSpec } from '../../ports/client/contract.js'
import type { RoleSession, SmokeRole, SmokeRun, SmokeSetting, SmokeStep, StepRecord } from '../../release/consumer-smoke.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readShiftGate } from '../../../src/manifest.js'
import { answerPolicy } from '../../nodes/answer/answerer.js'
import { launchPolicy } from '../../nodes/launch/launch-starter.js'
import { InMemoryGh } from '../../ports/gh.js'
import {
  AdapterRoleSession,
  answerOwnerQuestionOf,
  baseBranchOf,
  CARD_SESSION_ROLE,
  cardBranchOf,
  CLAIMED_CAPABILITIES,
  headlessArgs,
  postSmokeStatus,
  recordsOfTranscript,
  runSmoke,
  SMOKE_ROLES,
  smokePlan,
  smokeStatus,
  STATUS_DESCRIPTION_LIMIT,
} from '../../release/consumer-smoke.js'
import { SMOKE_STATUS_CONTEXT } from '../../release/version-pr-guard.js'

const HEAD = '0123456789abcdef0123456789abcdef01234567'

const SETTING: SmokeSetting = { head: HEAD, browserLab: '/opt/construct/bin/browser-lab', url: 'https://example.com', ghRepo: 'o/scratch', secondClient: role => `second-client exec -C /scratch/trees/${role} ok` }

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..')

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

function recordIn(run: SmokeRun, role: SmokeRole, capability: string): StepRecord | undefined {
  return run.records.find(entry => entry.role === role && entry.capability === capability)
}

describe('the consumer smoke runs the first step of every claimed capability in each role', () => {
  it('the consumer smoke records the exit and output of the first step of every claimed capability in each role', () => {
    const session = new StubSession(step => ({ exit: 0, output: `${step.role} ${step.capability} said ok` }))

    const run = runSmoke(HEAD, smokePlan(SETTING), session)

    expect(session.asked.map(asked => asked.role)).toEqual([...SMOKE_ROLES])
    for (const role of SMOKE_ROLES) {
      for (const capability of CLAIMED_CAPABILITIES)
        expect(recordIn(run, role, capability), `${role} ${capability}`).toMatchObject({ exit: 0, output: `${role} ${capability} said ok` })
      expect(recordIn(run, role, 'browser-lab')?.command).toBe(`/opt/construct/bin/browser-lab page https://example.com --shot smoke-shots/${role}.png`)
      expect(recordIn(run, role, 'codex-exec')?.command).toBe(`second-client exec -C /scratch/trees/${role} ok`)
      expect(recordIn(run, role, 'gh-read')?.command).toBe('gh repo view o/scratch --json name')
      expect(recordIn(run, role, 'git-commit')?.command).toMatch(/^git commit /)
    }
    expect(run.verdict.passed).toBe(true)
    expect(smokeStatus(run)).toMatchObject({ state: 'success', context: SMOKE_STATUS_CONTEXT })
  })

  it('refuses a browser-lab that is not the installed absolute path', () => {
    expect(() => smokePlan({ ...SETTING, browserLab: 'browser-lab' })).toThrow(/installed absolute path/)
  })

  it('records a step the session never returned as not run, and the run is red', () => {
    const run = runSmoke(HEAD, smokePlan(SETTING), new StubSession(step => step.role === 'review' && step.capability === 'gh-read' ? null : { exit: 0, output: 'ok' }))

    expect(recordIn(run, 'review', 'gh-read')).toMatchObject({ exit: null })
    expect(run.verdict.passed).toBe(false)
    expect(run.verdict.lines.join('\n')).toContain('review: gh-read did not run')
  })
})

describe('a red smoke names what to fix', () => {
  it('a capability whose first step failed in a role is named with that role in the red verdict', () => {
    const session = new StubSession((step) => {
      if (step.role === 'window' && step.capability === 'codex-exec')
        return { exit: 1, output: 'error: second client is not logged in\nmore' }
      if (step.role === 'answer' && step.capability === 'git-commit')
        return { exit: null, output: 'Permission to use Bash has been denied' }
      return { exit: 0, output: 'ok' }
    })

    const run = runSmoke(HEAD, smokePlan(SETTING), session)

    expect(run.verdict.passed).toBe(false)
    const text = run.verdict.lines.join('\n')
    expect(text).toContain('window: codex-exec exited 1 — error: second client is not logged in')
    expect(text).toContain('answer: git-commit did not run — Permission to use Bash has been denied')
    expect(text).not.toContain('launch:')
    expect(smokeStatus(run)).toEqual({ state: 'failure', context: SMOKE_STATUS_CONTEXT, description: 'red: answer git-commit, window codex-exec' })
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
    expect(recordIn(run, CARD_SESSION_ROLE, 'git-push')).toMatchObject({ exit: 0, command: `git push -u origin ${branch}` })
    expect(recordIn(run, CARD_SESSION_ROLE, 'pull-request')).toMatchObject({ exit: 0, output: 'https://github.com/o/scratch/pull/7' })
    expect(recordIn(run, CARD_SESSION_ROLE, 'pull-request')?.command).toContain(`--base ${baseBranchOf(HEAD)} --head ${branch}`)
    expect(run.records.filter(entry => entry.role !== CARD_SESSION_ROLE && entry.capability === 'pull-request')).toEqual([])
  })

  it('a card session whose commit is refused leaves the pull request red, naming the card role', () => {
    const gitSteps = new Set(['git-commit', 'git-push', 'pull-request'])
    const run = runSmoke(HEAD, smokePlan(SETTING), new StubSession(step => step.role === CARD_SESSION_ROLE && gitSteps.has(step.capability) ? { exit: 128, output: 'fatal: Unable to create index.lock: Operation not permitted' } : { exit: 0, output: 'ok' }))

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

const spawned = (stdout: string): SpawnSyncReturns<string> => ({ pid: 1, output: [], stdout, stderr: '', status: 0, signal: null })

function specsOfRoles(treeOf: (role: SmokeRole) => string): Map<SmokeRole, SessionSpec> {
  const specs = new Map<SmokeRole, SessionSpec>()
  const session = new AdapterRoleSession(treeOf, {
    sessionId: () => 'session-1',
    invocationOf: (spec) => {
      specs.set(spec.role as SmokeRole, spec)
      return { command: 'client-bin', args: ['-p'], env: {}, stdin: spec.prompt }
    },
    spawn: () => spawned(''),
    transcriptOf: () => '',
  })
  for (const role of SMOKE_ROLES)
    session.run(role, smokePlan(SETTING).filter(step => step.role === role))
  return specs
}

describe('the smoke starts each card role with the policy the product builds', () => {
  it('the smoke starts the launch and answer sessions with the sandboxed policy the product launch paths build', () => {
    const tree = REPOSITORY_ROOT
    const gate = readShiftGate(tree)

    const specs = specsOfRoles(() => tree)

    expect(gate.prepush.length).toBeGreaterThan(0)
    expect(specs.get('launch')!.policy).toEqual(launchPolicy(gate))
    expect(specs.get('answer')!.policy).toEqual(answerPolicy(gate, [answerOwnerQuestionOf(tree)]))
    for (const role of ['launch', 'answer'] as const) {
      expect(specs.get(role)!.policy.profile, role).toBe('sandboxed')
      expect(specs.get(role)!.policy.gateCommands, role).toEqual(gate.prepush)
      expect(specs.get(role)!.policy.mcpOff, role).toBe(true)
    }
  })

  it('the product launch and answer policies are sandboxed with the tree gate', () => {
    const gate = { prepush: ['pnpm run quality'] }

    expect(launchPolicy({ ...gate, handoffWrite: null, codeMatrix: null }, [])).toEqual({ profile: 'sandboxed', gateCommands: ['pnpm run quality'], writePaths: [], mcpOff: true, tools: [] })
    expect(answerPolicy(gate, ['/factory/answer/q.md'])).toEqual({ profile: 'sandboxed', gateCommands: ['pnpm run quality'], writePaths: ['/factory/answer/q.md'], mcpOff: true, tools: undefined })
  })
})

describe('the smoke posts its verdict as a commit status', () => {
  const posted = (status: ReturnType<typeof smokeStatus>): string[] => {
    const gh = new InMemoryGh(() => '{}')
    postSmokeStatus('o/r', HEAD, status, gh.port())
    return gh.calls[0]!.args
  }

  it('postSmokeStatus posts failure for a red smoke with a description of at most 140 characters', () => {
    const run = runSmoke(HEAD, smokePlan(SETTING), new StubSession(() => ({ exit: 1, output: 'refused' })))

    const args = posted(smokeStatus(run))

    expect(args.slice(0, 4)).toEqual(['api', '--method', 'POST', `repos/o/r/statuses/${HEAD}`])
    expect(args).toContain('state=failure')
    expect(args).not.toContain('state=success')
    expect(args).toContain(`context=${SMOKE_STATUS_CONTEXT}`)
    const description = args.find(arg => arg.startsWith('description='))!.slice('description='.length)
    expect(STATUS_DESCRIPTION_LIMIT).toBe(140)
    expect(description.length).toBeLessThanOrEqual(140)
    expect(description.length).toBeGreaterThan(100)
    expect(description.startsWith('red: launch browser-lab')).toBe(true)
    expect(smokeStatus(run).description.length).toBeLessThanOrEqual(140)
    expect(posted({ state: 'failure', context: SMOKE_STATUS_CONTEXT, description: 'x'.repeat(300) })).toContain(`description=${'x'.repeat(140)}`)
  })

  it('postSmokeStatus posts success only for a green smoke', () => {
    const run = runSmoke(HEAD, smokePlan(SETTING), new StubSession())

    expect(posted(smokeStatus(run))).toContain('state=success')
  })

  it('a smoke with no step recorded is not green', () => {
    expect(smokeStatus({ head: HEAD, records: [], verdict: { passed: true, lines: [] } }).state).toBe('failure')
  })

  it('throws when the status could not be posted', () => {
    const gh = new InMemoryGh(() => ({ status: 1, stdout: '', stderr: 'HTTP 404' }))

    expect(() => postSmokeStatus('o/r', HEAD, { state: 'success', context: SMOKE_STATUS_CONTEXT, description: 'ok' }, gh.port({ attempts: 1 }))).toThrow(/was not posted/)
  })
})

describe('a live session transcript becomes the step records', () => {
  const steps: SmokeStep[] = smokePlan(SETTING).filter(step => step.role === 'review')

  it('reads the exit and output of each Bash call that ran a planned command', () => {
    const [shot, codex, gh] = steps
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

    expect(records.map(record => [record.capability, record.exit])).toEqual([['browser-lab', 0], ['codex-exec', 2], ['gh-read', null], ['git-commit', null]])
    expect(records[0]!.output).toBe('saved smoke-shots/review.png')
    expect(records[2]!.output).toContain('denied')
    expect(records[3]!.output).toBe('the session never ran this command')
  })

  it('starts the role session through the client adapter in the role tree and reads its transcript', () => {
    const specs: SessionSpec[] = []
    const runs: { invocation: Invocation, args: string[], cwd: string }[] = []
    const session = new AdapterRoleSession(role => `/scratch/trees/${role}`, {
      sessionId: () => 'session-1',
      invocationOf: (spec) => {
        specs.push(spec)
        return { command: 'client-bin', args: ['--card', '-p'], env: {}, stdin: spec.prompt }
      },
      spawn: (invocation, args, cwd) => {
        runs.push({ invocation, args, cwd })
        return spawned('')
      },
      transcriptOf: (cwd, id) => cwd === '/scratch/trees/review' && id === 'session-1' ? [bashUse('x', steps[0]!.command), bashResult('x', [{ type: 'text', text: 'shot' }])].join('\n') : '',
    })

    const records = session.run('review', steps)

    expect(specs[0]).toMatchObject({ kind: 'start', role: 'review', session: 'session-1', cwd: '/scratch/trees/review' })
    expect(specs[0]!.prompt).toContain(steps[0]!.command)
    expect(runs).toEqual([{ invocation: { command: 'client-bin', args: ['--card', '-p'], env: {}, stdin: specs[0]!.prompt }, args: ['--card', '-p'], cwd: '/scratch/trees/review' }])
    expect(records[0]).toMatchObject({ exit: 0, output: 'shot' })
    expect(records[1]).toMatchObject({ exit: null, output: 'the session never ran this command' })
  })

  it('runs an interactive invocation, as the window has, headless with its prompt', () => {
    expect(headlessArgs({ command: 'client-bin', args: ['--window', 'do it'], env: {}, stdin: null })).toEqual(['--window', 'do it', '-p'])
    expect(headlessArgs({ command: 'client-bin', args: ['-p', 'do it'], env: {}, stdin: null })).toEqual(['-p', 'do it'])
    expect(headlessArgs({ command: 'client-bin', args: ['--card'], env: {}, stdin: 'do it' })).toEqual(['--card'])
  })

  it('records every step of a role the client refuses as not run, with the refusal', () => {
    const refusal: Refusal = { kind: 'refused', reason: 'this client opens no window' }
    const session = new AdapterRoleSession(role => `/scratch/trees/${role}`, { invocationOf: () => refusal, spawn: () => spawned(''), transcriptOf: () => '' })

    const records = session.run('window', smokePlan(SETTING).filter(step => step.role === 'window'))

    expect(records.every(record => record.exit === null && record.output === 'the client refused the window session: this client opens no window')).toBe(true)
  })
})
