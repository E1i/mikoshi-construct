import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'

interface LadderResult {
  status: string
  recovery?: string
  effort?: string
  attempts: { rung: number, effort: string, outcome: string, reason: string }[]
  validationError?: string
  question?: string
  lastFailure?: string
  acceptance?: string[]
  invariants?: string[]
  immutable?: string[]
  contractChanged?: boolean
  changedFiles?: string[]
  onRedBase?: boolean
  knownBaseFailures?: number
  newFailures?: number
  fixedOnTheWay?: string[]
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

const DEFAULT_ACCEPTANCE = ['the rule rejects the case']
const WITNESS_COMMAND = 'pnpm vitest run tests/rule.test.ts'
const WITNESS_SHA256 = crypto.createHash('sha256').update(WITNESS_COMMAND).digest('hex')

function witnessed(items: string[], outcome: { baseExitCode: number, afterExitCode: number, baseExcerpt?: string } = { baseExitCode: 1, afterExitCode: 0 }): unknown[] {
  return items.map(criterion => ({ criterion, command: WITNESS_COMMAND, ranSha256: WITNESS_SHA256, baseExcerpt: outcome.baseExitCode === 0 ? '1 passed' : '1 failed', ...outcome }))
}

const INSTALLED = { command: 'pnpm install --frozen-lockfile', exitCode: 0 }

const ARGS_PATH = '.construct/implement-args.json'
const ARGS_SHA256 = 'a'.repeat(64)

const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'

const STEPS = ['pnpm lint', 'pnpm test']
const PIN = 'b'.repeat(64)

const REPORT = { status: 'done', summary: 'changed the ladder', files: ['a.ts'], harnessTail: 'ok', question: '' }
const GREEN = { passed: true, failureExcerpt: '', securityFinding: '', diffStat: ' 1 file changed', testsWeakened: false, changedFiles: ['a.ts'], baseSha: BASE_SHA, baseInstall: INSTALLED, argsSha256: ARGS_SHA256, witnesses: witnessed(DEFAULT_ACCEPTANCE) }
const RED = { passed: false, failureExcerpt: 'vitest failed', securityFinding: '', diffStat: '', testsWeakened: false, changedFiles: ['a.ts'], baseSha: BASE_SHA, baseInstall: INSTALLED, argsSha256: ARGS_SHA256, witnesses: [] }

function fixedWitnesses(items: string[]): { criterion: string, command: string }[] {
  return items.map(criterion => ({ criterion, command: WITNESS_COMMAND }))
}

function fixedWitnessDigests(items: string[]): { criterion: string, base64: string, sha256: string }[] {
  return items.map(criterion => ({ criterion, base64: Buffer.from(WITNESS_COMMAND).toString('base64'), sha256: WITNESS_SHA256 }))
}

async function run(args: Record<string, unknown>, replies: Record<string, Reply[]>, base: Reply = GREEN): Promise<{ result: LadderResult, calls: AgentCall[] }> {
  const queues: Record<string, Reply[]> = { architect: [], implementer: [], ...replies, harness: [base, ...(replies.harness ?? [])] }
  const calls: AgentCall[] = []
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, prompt })
    const reply = queues[options.agentType].shift()
    if (reply instanceof Error)
      throw reply
    return reply ?? null
  }
  const acceptance = (args.acceptance as string[] | undefined) ?? DEFAULT_ACCEPTANCE
  const result = await ladder()({ argsPath: ARGS_PATH, argsSha256: ARGS_SHA256, harness: { command: 'pnpm run quality', steps: STEPS, baseFailuresSha256: PIN }, acceptance, witnesses: fixedWitnesses(acceptance), witnessDigests: fixedWitnessDigests(acceptance), ...args }, agent, () => {}, () => {})
  return { result, calls }
}

const LINT = 'a.ts › rule-a'
const TESTS = ['t.test.ts › one', 't.test.ts › two']

function stepsOf(lint: string[] | null, tests: string[] | null): unknown[] {
  return [
    { step: STEPS[0], exitCode: lint === null || lint.length > 0 ? 1 : 0, failures: lint },
    { step: STEPS[1], exitCode: tests === null || tests.length > 0 ? 1 : 0, failures: tests },
  ]
}

function verdict(steps: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const red = (steps as { exitCode: number }[]).some(entry => entry.exitCode !== 0)
  return { ...(red ? RED : GREEN), steps, setSha256: PIN, baselineSha256: 'c'.repeat(64), ...extra }
}

const RED_BASE = verdict(stepsOf([LINT], TESTS))
const REPORTED = { ...REPORT }
const GREEN_AFTER = { witnesses: GREEN.witnesses }

describe('the ladder on a red base', () => {
  it('w1: a red base whose every red step has an identified failure set and the pinned sha256 runs the implementer', async () => {
    const { result, calls } = await run({ task: 'fix', effort: 'low' }, { implementer: [REPORTED], harness: [verdict(stepsOf([LINT], TESTS), GREEN_AFTER)] }, RED_BASE)

    expect(calls.map(call => call.agentType)).toEqual(['harness', 'implementer', 'harness'])
    expect(result.status).toBe('done')
  })

  it('w2: a tree with the base failures and no others is done, and the result counts the known ones and the new ones', async () => {
    const { result } = await run({ task: 'fix', effort: 'low' }, { implementer: [REPORTED], harness: [verdict(stepsOf([LINT], TESTS), GREEN_AFTER)] }, RED_BASE)

    expect(result).toMatchObject({ status: 'done', onRedBase: true, knownBaseFailures: 3, newFailures: 0, fixedOnTheWay: [] })
  })

  it('w3: one failure the base did not have fails the rung, and the next implementer prompt names only that one', async () => {
    const added = 't.test.ts › three'
    const { result, calls } = await run({ task: 'fix', effort: 'low' }, {
      implementer: [REPORTED, REPORTED],
      harness: [verdict(stepsOf([LINT], [...TESTS, added]), { failureExcerpt: 'EXCERPT-OF-EVERYTHING' }), verdict(stepsOf([LINT], TESTS), GREEN_AFTER)],
    }, RED_BASE)

    expect(result.attempts[0]).toMatchObject({ outcome: 'harness failed', reason: `${STEPS[1]} › ${added}` })
    const second = calls.filter(call => call.agentType === 'implementer')[1].prompt
    expect(second).toContain(`${STEPS[1]} › ${added}`)
    expect(second).not.toContain('EXCERPT-OF-EVERYTHING')
    expect(second.split('The previous attempt failed')[1]).not.toContain(TESTS[0])
  })

  it('w4: a step green on the base and red after fails the rung, whether its failure list is empty or null', async () => {
    for (const lint of [[], null]) {
      const greenLintBase = verdict(stepsOf([], TESTS))
      const { result } = await run({ task: 'fix', effort: 'low' }, {
        implementer: [REPORTED],
        harness: [{ ...verdict(stepsOf([], TESTS), GREEN_AFTER), steps: [{ step: STEPS[0], exitCode: 1, failures: lint }, ...(stepsOf([], TESTS).slice(1))] }],
      }, greenLintBase)

      expect(result.attempts[0].outcome).toBe('harness failed')
    }
  })

  it('w5: a failure gone after the change is done and named in fixedOnTheWay', async () => {
    const { result } = await run({ task: 'fix', effort: 'low' }, { implementer: [REPORTED], harness: [verdict(stepsOf([LINT], [TESTS[0]]), GREEN_AFTER)] }, RED_BASE)

    expect(result).toMatchObject({ status: 'done', knownBaseFailures: 3, newFailures: 0, fixedOnTheWay: [`${STEPS[1]} › ${TESTS[1]}`] })
  })

  it('w6: a red step with null failures on the base is base red and runs nothing', async () => {
    const { result, calls } = await run({ task: 'fix', effort: 'low' }, {}, verdict(stepsOf([LINT], null)))

    expect(result.status).toBe('base red')
    expect(calls.map(call => call.agentType)).toEqual(['harness'])
  })

  it('w7: a red base with no pin, or a pin that is not the set sha256, is base unverified and runs nothing', async () => {
    const withoutPin = await run({ task: 'fix', effort: 'low', harness: { command: 'pnpm run quality', steps: STEPS } }, {}, RED_BASE)
    const wrongPin = await run({ task: 'fix', effort: 'low' }, {}, { ...RED_BASE, setSha256: 'd'.repeat(64) })

    for (const { result, calls } of [withoutPin, wrongPin]) {
      expect(result.status).toBe('base unverified')
      expect(result.validationError).toContain('pinned')
      expect(calls.map(call => call.agentType)).toEqual(['harness'])
    }
    expect(wrongPin.result.validationError).toContain('d'.repeat(64))
  })

  it('w8: the implementer prompt on a red base names the base failures as known and out of scope', async () => {
    const { calls } = await run({ task: 'fix', effort: 'low' }, { implementer: [REPORTED], harness: [verdict(stepsOf([LINT], TESTS), GREEN_AFTER)] }, RED_BASE)

    const prompt = calls.find(call => call.agentType === 'implementer')?.prompt ?? ''
    expect(prompt).toContain('known and out of this task')
    for (const identity of [LINT, ...TESTS])
      expect(prompt).toContain(identity.startsWith('a.ts') ? `${STEPS[0]} › ${identity}` : `${STEPS[1]} › ${identity}`)
  })

  it('w9: a diff beyond the sketch on a red base with identified failures is still base red', async () => {
    const { result, calls } = await run({ task: 'fix', effort: 'low', sketch: { branch: 'sketch/x', sha: 'e'.repeat(40), tree: 'f'.repeat(40) } }, {}, { ...RED_BASE, stagedTree: 'f'.repeat(40), unstagedPaths: ['src/x.ts'] })

    expect(result.status).toBe('base red')
    expect(calls.map(call => call.agentType)).toEqual(['harness'])
  })

  it('w10: the preflight and the verify prompts of a red base tell the harness to run check-baseline.mjs with every step and to pass its stdout on verbatim', async () => {
    const { calls } = await run({ task: 'fix', effort: 'low' }, { implementer: [REPORTED], harness: [verdict(stepsOf([LINT], TESTS), GREEN_AFTER)] }, RED_BASE)

    for (const call of calls.filter(entry => entry.agentType === 'harness')) {
      expect(call.prompt).toContain('node scripts/construct/check-baseline.mjs')
      for (const step of STEPS)
        expect(call.prompt).toContain(`- ${step}`)
      expect(call.prompt).toContain('verbatim')
      expect(call.prompt).toContain('shasum -a 256')
    }
  })

  it('w11: the harness agent and the implement skill templates name check-baseline.mjs, the verbatim stdout with its shasum, base unverified and the red-base result line', () => {
    const agent = readFileSync(path.join(REPO_ROOT, 'templates/ai/claude/_claude/agents/harness.md'), 'utf8')
    const skill = readFileSync(path.join(REPO_ROOT, 'templates/ai/claude/_claude/skills/implement/SKILL.md'), 'utf8')

    expect(agent).toContain('check-baseline.mjs')
    expect(agent).toContain('shasum -a 256')
    expect(agent).toContain('verbatim')
    expect(skill).toContain('base unverified')
    expect(skill).toContain('passed on a red base: N known, 0 new')
  })
})
