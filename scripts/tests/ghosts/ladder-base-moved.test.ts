import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORKFLOW = 'scripts/construct/implement.workflow'
const ARGS_PATH = '.construct/implement-args.json'
const ARGS_SHA256 = 'a'.repeat(64)
const OLD_BASE = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'
const NEW_BASE = 'e238c9d0e238c9d0e238c9d0e238c9d0e238c9d0'
const THE_ONLY_STATUS_THAT_IS_NO_FALL = 'done'

interface Attempt { rung: number, effort: string, outcome: string, reason: string }

interface LadderResult {
  status: string
  attempts: Attempt[]
}

interface AgentCall {
  agentType: string
  label: string
  prompt: string
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)
}

const WITNESSES = [
  { criterion: 'the rule rejects the case', command: 'pnpm vitest run tests/rule.test.ts' },
  { criterion: 'the reader reads the record', command: 'pnpm vitest run tests/reader/' },
]

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

const DIGESTS = WITNESSES.map(({ criterion, command }) => ({ criterion, base64: Buffer.from(command).toString('base64'), sha256: sha256(command) }))
const WITNESS_PATHS = [
  { criterion: WITNESSES[0].criterion, paths: ['tests/rule.test.ts'] },
  { criterion: WITNESSES[1].criterion, paths: ['tests/reader/'] },
]

const REPORT = { status: 'done', summary: 'changed the rule', files: ['src/rule.ts', 'tests/rule.test.ts'], harnessTail: 'ok', question: '' }
const REWORKED = { ...REPORT, summary: 'reworked the conflicting hunk' }

function witnessed(criteria: string[] = WITNESSES.map(witness => witness.criterion)): unknown[] {
  return WITNESSES.filter(witness => criteria.includes(witness.criterion))
    .map(({ criterion, command }) => ({ criterion, ranSha256: sha256(command), baseExitCode: 1, afterExitCode: 0, baseExcerpt: '1 failed', afterExcerpt: '1 passed' }))
}

function verdict(headSha: string, witnesses: unknown[] = witnessed()): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: ' 2 files changed',
    testsWeakened: false,
    changedFiles: REPORT.files,
    baseSha: OLD_BASE,
    headSha,
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256: ARGS_SHA256,
    witnesses,
  }
}

const PREFLIGHT = { ...verdict(OLD_BASE, []), changedFiles: [] }

function rebase(outcome: string, conflictingHunks: string[] = []): Record<string, unknown> {
  return { outcome, baseChangedFiles: ['tests/rule.test.ts', 'docs/cli.md'], conflictingHunks, witnessPaths: WITNESS_PATHS }
}

async function run(queues: Record<string, unknown[]>): Promise<{ result: LadderResult, calls: AgentCall[] }> {
  const calls: AgentCall[] = []
  const agent = async (prompt: string, options: { agentType: string, label: string }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, label: options.label, prompt })
    const queue = queues[options.label.split(' ')[0]] ?? []
    return queue.shift() ?? null
  }
  const result = await ladder()({
    argsPath: ARGS_PATH,
    argsSha256: ARGS_SHA256,
    task: 'reject the case',
    effort: 'low',
    harness: { command: 'pnpm run quality' },
    acceptance: WITNESSES.map(witness => witness.criterion),
    witnessDigests: DIGESTS,
  }, agent, () => {}, () => {})
  return { result, calls }
}

function labels(calls: AgentCall[]): string[] {
  return calls.map(call => call.label.split(' ')[0])
}

function countsAsAFall(result: LadderResult): boolean {
  return result.status !== THE_ONLY_STATUS_THAT_IS_NO_FALL
}

describe('the ladder when the base moves under a finished attempt', () => {
  it('keeps the finished diff when the base moves and re-runs only the witnesses whose files the base changed', async () => {
    const { result, calls } = await run({
      preflight: [PREFLIGHT],
      implement: [REPORT],
      verify: [verdict(NEW_BASE), verdict(NEW_BASE, witnessed([WITNESSES[0].criterion]))],
      rebase: [rebase('clean')],
    })

    expect(result.status).toBe('done')
    expect(countsAsAFall(result)).toBe(false)
    expect(labels(calls)).toEqual(['preflight', 'implement', 'verify', 'rebase', 'verify'])
    const reverify = calls.at(-1)!.prompt
    expect(reverify).toContain('Harness command: pnpm run quality')
    expect(reverify).toContain(WITNESSES[0].criterion)
    expect(reverify).not.toContain(WITNESSES[1].criterion)
    expect(reverify).toContain(`git worktree add --detach "$base" ${NEW_BASE}`)
    expect(calls.find(call => call.label.startsWith('rebase'))!.prompt).toContain(`moved from ${OLD_BASE} to ${NEW_BASE}`)
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['base moved, diff kept', 'passed'])
    expect(result.attempts.some(attempt => attempt.outcome === 'base moved')).toBe(false)
  })

  it('reworks only the conflicting hunks and verifies the whole set again', async () => {
    const hunk = 'src/rule.ts: @@ -10,4 +10,6 @@'
    const { result, calls } = await run({
      preflight: [PREFLIGHT],
      implement: [REPORT],
      verify: [verdict(NEW_BASE), verdict(NEW_BASE)],
      rebase: [rebase('conflict', [hunk])],
      rework: [REWORKED],
    })

    expect(result.status).toBe('done')
    expect(labels(calls)).toEqual(['preflight', 'implement', 'verify', 'rebase', 'rework', 'verify'])
    const rework = calls.find(call => call.label.startsWith('rework'))!.prompt
    expect(rework).toContain(hunk)
    expect(rework).toContain('Rework only those hunks')
    const reverify = calls.at(-1)!.prompt
    for (const { criterion } of WITNESSES)
      expect(reverify).toContain(criterion)
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['base moved, hunks reworked', 'passed'])
  })

  it('starts a fresh attempt when the diff does not apply, on the same rung and from the new base', async () => {
    const { result, calls } = await run({
      preflight: [PREFLIGHT],
      implement: [REPORT, REPORT],
      verify: [verdict(NEW_BASE), verdict(NEW_BASE)],
      rebase: [rebase('does not apply')],
    })

    expect(result.status).toBe('done')
    expect(labels(calls)).toEqual(['preflight', 'implement', 'verify', 'rebase', 'implement', 'verify'])
    const implementLabels = calls.filter(call => call.agentType === 'implementer' && call.label.startsWith('implement')).map(call => call.label)
    expect(implementLabels).toEqual(['implement 1/4 @ low', 'implement 1/4 @ low'])
    expect(calls.filter(call => call.label.startsWith('implement'))[1].prompt).toContain(`The base is ${NEW_BASE}.`)
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['base moved, fresh attempt', 'passed'])
  })

  it('stops on base moved when the base keeps moving past the kept limit', async () => {
    const third = 'f'.repeat(40)
    const fourth = 'e'.repeat(40)
    const { result } = await run({
      preflight: [PREFLIGHT],
      implement: [REPORT],
      verify: [verdict(NEW_BASE), verdict(third), verdict(fourth)],
      rebase: [rebase('clean'), rebase('clean')],
    })

    expect(result.status).toBe('base moved')
    expect(result.attempts.at(-1)).toMatchObject({ outcome: 'base moved', reason: `HEAD ${fourth} is not the base ${third}` })
  })

  it('re-runs a witness whose paths the rebase did not report', async () => {
    const { calls } = await run({
      preflight: [PREFLIGHT],
      implement: [REPORT],
      verify: [verdict(NEW_BASE), verdict(NEW_BASE)],
      rebase: [{ ...rebase('clean'), witnessPaths: [] }],
    })

    const reverify = calls.at(-1)!.prompt
    for (const { criterion } of WITNESSES)
      expect(reverify).toContain(criterion)
  })
})
