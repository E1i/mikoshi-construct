import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'
const ARGS_PATH = '.construct/implement-args.json'
const ARGS_SHA256 = 'a'.repeat(64)

interface LadderResult {
  status: string
  attempts: { rung: number, effort: string, outcome: string, reason: string }[]
  lastFailure?: string
}

interface AgentCall {
  agentType: string
  prompt: string
}

type Reply = unknown | Error

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)
}

const SPEC = {
  decision: 'keep the change local',
  contractChanges: '',
  compositionChanges: '',
  constraints: [],
  acceptance: ['the rule rejects the case'],
  files: ['a.ts'],
}

const ACCEPTANCE = ['the rule rejects the case']
const WITNESS_COMMAND = 'pnpm vitest run tests/rule.test.ts'
const WITNESS_SHA256 = crypto.createHash('sha256').update(WITNESS_COMMAND).digest('hex')
const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'
const CONTRACT_CHECK_COMMAND = 'make contract-marker-283'
const CONTRACT_CHECK_EXCERPT = 'declared: none\ndeclared none is weaker than required minor: add a changeset of level minor for mikoshi-construct'

const REPORT = { status: 'done', summary: 'changed the rule', files: ['a.ts'], harnessTail: 'ok', question: '' }

const INSTALLED = { command: 'pnpm install --frozen-lockfile', exitCode: 0 }

function witnessed(): unknown[] {
  return ACCEPTANCE.map(criterion => ({ criterion, command: WITNESS_COMMAND, ranSha256: WITNESS_SHA256, baseExitCode: 1, afterExitCode: 0, baseExcerpt: '1 failed' }))
}

function verdict(contractCheck?: { command: string, exitCode: number, excerpt: string }): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: ' 1 file changed',
    testsWeakened: false,
    changedFiles: ['a.ts'],
    baseSha: BASE_SHA,
    baseInstall: INSTALLED,
    argsSha256: ARGS_SHA256,
    witnesses: witnessed(),
    ...(contractCheck === undefined ? {} : { contractCheck }),
  }
}

const PREFLIGHT = verdict()
const RED_CHECK = verdict({ command: CONTRACT_CHECK_COMMAND, exitCode: 1, excerpt: CONTRACT_CHECK_EXCERPT })
const GREEN_CHECK = verdict({ command: CONTRACT_CHECK_COMMAND, exitCode: 0, excerpt: '' })
const NO_CHECK_REPORTED = verdict()

const DECLARED_HARNESS = { command: 'pnpm run quality', contractPaths: ['contract/surface.json'], contractCheck: CONTRACT_CHECK_COMMAND }

function fixedWitnesses(): { criterion: string, command: string }[] {
  return ACCEPTANCE.map(criterion => ({ criterion, command: WITNESS_COMMAND }))
}

function fixedWitnessDigests(): { criterion: string, base64: string, sha256: string }[] {
  return ACCEPTANCE.map(criterion => ({ criterion, base64: Buffer.from(WITNESS_COMMAND).toString('base64'), sha256: WITNESS_SHA256 }))
}

async function run(harness: Record<string, unknown>, harnessReplies: Reply[]): Promise<{ result: LadderResult, calls: AgentCall[] }> {
  const queues: Record<string, Reply[]> = { architect: [SPEC, SPEC], implementer: [REPORT, REPORT, REPORT], harness: [PREFLIGHT, ...harnessReplies] }
  const calls: AgentCall[] = []
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, prompt })
    const reply = queues[options.agentType].shift()
    if (reply instanceof Error)
      throw reply
    return reply ?? null
  }
  const result = await ladder()({
    argsPath: ARGS_PATH,
    argsSha256: ARGS_SHA256,
    task: 'declare the check',
    effort: 'medium',
    harness: { command: 'pnpm run quality', ...harness },
    acceptance: ACCEPTANCE,
    witnesses: fixedWitnesses(),
    witnessDigests: fixedWitnessDigests(),
  }, agent, () => {}, () => {})
  return { result, calls }
}

describe('the declared contract check', () => {
  it('a red contract check is not done', async () => {
    const { result, calls } = await run(DECLARED_HARNESS, [RED_CHECK, GREEN_CHECK])

    expect(result.attempts[0]).toMatchObject({ outcome: 'contract check failed' })
    expect(result.attempts[0].reason).toContain(CONTRACT_CHECK_EXCERPT)
    const implementerCalls = calls.filter(call => call.agentType === 'implementer')
    expect(implementerCalls.length).toBeGreaterThan(1)
    expect(implementerCalls[1].prompt).toContain(CONTRACT_CHECK_EXCERPT)
    expect(result.status).toBe('done')
  })

  it('an unreported contract check is not done', async () => {
    const { result } = await run(DECLARED_HARNESS, [NO_CHECK_REPORTED, GREEN_CHECK])

    expect(result.attempts[0]).toMatchObject({ outcome: 'contract check failed' })
    expect(result.attempts[0].reason).toContain('the harness did not report the contract check')
  })

  it('a green contract check is done', async () => {
    const { result } = await run(DECLARED_HARNESS, [GREEN_CHECK])

    expect(result.status).toBe('done')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['passed'])
  })

  it('three red contract checks end the run failed with the check output', async () => {
    const { result } = await run(DECLARED_HARNESS, [RED_CHECK, RED_CHECK, RED_CHECK])

    expect(result.status).toBe('failed')
    expect(result.lastFailure).toContain(CONTRACT_CHECK_EXCERPT)
  })

  it('an undeclared contract check changes nothing', async () => {
    const undeclared = { command: 'pnpm run quality', contractPaths: [], contractCheck: '' }
    const withCheck = await run(undeclared, [RED_CHECK])
    const withoutCheck = await run(undeclared, [verdict()])

    expect(withCheck.result.status).toBe('done')
    expect(withCheck.result.attempts.map(attempt => attempt.outcome)).toEqual(['passed'])
    const harnessPrompts = (run_: { calls: AgentCall[] }) => run_.calls.filter(call => call.agentType === 'harness').map(call => call.prompt)
    expect(harnessPrompts(withCheck)).toEqual(harnessPrompts(withoutCheck))
  })

  it('a green check reported under another command is not done, and the reason names both commands', async () => {
    const { result, calls } = await run(DECLARED_HARNESS, [verdict({ command: 'make contract-marker', exitCode: 0, excerpt: '' }), GREEN_CHECK])

    expect(result.attempts[0]).toMatchObject({ outcome: 'contract check failed', reason: `the harness reported "make contract-marker", not the declared contract check "${CONTRACT_CHECK_COMMAND}"` })
    expect(calls.filter(call => call.agentType === 'implementer')[1].prompt).toContain('not the declared contract check')
    expect(result.status).toBe('done')
  })

  it('a check reported with surrounding whitespace is another command', async () => {
    const { result } = await run(DECLARED_HARNESS, [verdict({ command: ` ${CONTRACT_CHECK_COMMAND}`, exitCode: 0, excerpt: '' }), GREEN_CHECK])

    expect(result.attempts[0]).toMatchObject({ outcome: 'contract check failed' })
  })

  it('a red contract check with an empty excerpt names the command and its exit code', async () => {
    const { result, calls } = await run(DECLARED_HARNESS, [verdict({ command: CONTRACT_CHECK_COMMAND, exitCode: 1, excerpt: '' }), GREEN_CHECK])

    expect(result.attempts[0]).toMatchObject({ outcome: 'contract check failed', reason: `${CONTRACT_CHECK_COMMAND} exited 1` })
    expect(calls.filter(call => call.agentType === 'implementer')[1].prompt).toContain(`${CONTRACT_CHECK_COMMAND} exited 1`)
  })

  it('a red contract check with an excerpt names the command and its exit code before the excerpt', async () => {
    const { result } = await run(DECLARED_HARNESS, [RED_CHECK, GREEN_CHECK])

    expect(result.attempts[0].reason).toBe(`${CONTRACT_CHECK_COMMAND} exited 1\n${CONTRACT_CHECK_EXCERPT}`)
  })
})

function harnessPrompts(calls: AgentCall[]): string[] {
  return calls.filter(call => call.agentType === 'harness').map(call => call.prompt)
}

describe('the contract check changes the harness prompts only when declared', () => {
  const UNDECLARED: Record<string, Record<string, unknown>> = {
    'no contract paths and an empty check': { contractPaths: [], contractCheck: '' },
    'contract paths and an empty check': { contractPaths: ['contract/surface.json'], contractCheck: '' },
    'a check and no contract paths': { contractPaths: [], contractCheck: CONTRACT_CHECK_COMMAND },
    'contract paths and an undefined check': { contractPaths: ['contract/surface.json'], contractCheck: undefined },
    'contract paths and a null check': { contractPaths: ['contract/surface.json'], contractCheck: null },
    'contract paths and a numeric check': { contractPaths: ['contract/surface.json'], contractCheck: 1 },
  }

  for (const [name, harness] of Object.entries(UNDECLARED)) {
    it(`${name} leaves every harness prompt byte-identical to a run with no contract, and needs no check to be done`, async () => {
      const baseline = await run({}, [verdict()])
      const undeclared = await run(harness, [verdict()])

      expect(harnessPrompts(undeclared.calls)).toEqual(harnessPrompts(baseline.calls))
      expect(harnessPrompts(undeclared.calls).join('\n')).not.toContain('contract check')
      expect(undeclared.result.attempts.map(attempt => attempt.outcome)).toEqual(['passed'])
    })
  }

  it('a declared check is named in the verify prompt and not in the preflight prompt', async () => {
    const { calls } = await run(DECLARED_HARNESS, [GREEN_CHECK])
    const [preflight, verify] = harnessPrompts(calls)

    expect(verify).toContain(CONTRACT_CHECK_COMMAND)
    expect(preflight).not.toContain(CONTRACT_CHECK_COMMAND)
    expect(preflight).toBe(harnessPrompts((await run({}, [verdict()])).calls)[0])
  })

  it('pnpm contract:bump as the check declares it', async () => {
    const { result, calls } = await run({ contractPaths: ['contract/surface.json'], contractCheck: 'pnpm contract:bump' }, [NO_CHECK_REPORTED, verdict({ command: 'pnpm contract:bump', exitCode: 0, excerpt: '' })])

    expect(harnessPrompts(calls)[1]).toContain('A contract check is declared for this repository: pnpm contract:bump.')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['contract check failed', 'passed'])
  })
})
