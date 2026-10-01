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
  validationError?: string
}

interface Observed {
  baseExitCode: number
  afterExitCode: number
  baseExcerpt: string
  afterExcerpt?: string
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)
}

const CRITERION = 'the rule rejects the case'
const COMMAND = 'pnpm vitest run tests/rule.test.ts'
const SHA256 = crypto.createHash('sha256').update(COMMAND).digest('hex')
const SPEC = { decision: 'd', contractChanges: '', compositionChanges: '', constraints: [], acceptance: [], files: [] }
const REPORT = { status: 'done', summary: 's', files: ['a.ts'], harnessTail: 'ok', question: '' }
const GREEN_AFTER: Observed = { baseExitCode: 1, afterExitCode: 0, baseExcerpt: '1 failed', afterExcerpt: '1 passed' }

function verdict(observed: Observed, ranSha256 = SHA256): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: ' 1 file changed',
    testsWeakened: false,
    changedFiles: ['a.ts'],
    baseSha: '36f7abc9815cea1962b05bcf98bdcec193ba9fc5',
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256: ARGS_SHA256,
    witnesses: [{ criterion: CRITERION, command: COMMAND, ranSha256, ...observed }],
  }
}

async function run(verdicts: Record<string, unknown>[]): Promise<{ result: LadderResult, calls: Record<string, number> }> {
  const queues: Record<string, unknown[]> = { architect: [SPEC, SPEC], implementer: [REPORT, REPORT, REPORT], harness: [verdict(GREEN_AFTER), ...verdicts] }
  const calls: Record<string, number> = { architect: 0, implementer: 0, harness: 0 }
  const agent = async (_prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls[options.agentType] += 1
    return queues[options.agentType].shift() ?? null
  }
  const result = await ladder()({
    argsPath: ARGS_PATH,
    argsSha256: ARGS_SHA256,
    task: 't',
    effort: 'medium',
    harness: { command: 'pnpm run quality' },
    acceptance: [CRITERION],
    witnesses: [{ criterion: CRITERION, command: COMMAND }],
    witnessDigests: [{ criterion: CRITERION, base64: Buffer.from(COMMAND).toString('base64'), sha256: SHA256 }],
  }, agent, () => {}, () => {})
  return { result, calls }
}

async function outcomeOf(observed: Observed): Promise<string> {
  const { result } = await run([verdict(observed), verdict(GREEN_AFTER)])
  return result.attempts[0].outcome
}

describe('an invalid witness is not a red witness', () => {
  it('a witness failing the same way on the base and after is invalid and stops the run', async () => {
    const same: Observed = { baseExitCode: 1, afterExitCode: 1, baseExcerpt: 'Error: no rule', afterExcerpt: 'Error: no rule' }
    const { result, calls } = await run([verdict(same), verdict(GREEN_AFTER)])

    expect(result.status).toBe('base unverified')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({ outcome: 'witness invalid', reason: `Witness invalid: ${CRITERION}` })
    expect(result.validationError).toContain(CRITERION)
    expect(calls).toEqual({ architect: 0, implementer: 1, harness: 2 })

    const later = await run([verdict({ ...same, afterExcerpt: 'Error: another' }), verdict(same), verdict(GREEN_AFTER)])
    expect(later.result.attempts.map(attempt => attempt.outcome)).toEqual(['acceptance not witnessed', 'witness invalid'])
    expect(later.calls).toEqual({ architect: 0, implementer: 2, harness: 3 })
  })

  it('a witness green after, or red after with another failure, is decided as today', async () => {
    const green = await run([verdict(GREEN_AFTER)])
    expect(green.result.status).toBe('done')
    expect(green.result.attempts.map(attempt => attempt.outcome)).toEqual(['passed'])

    const another = await run([verdict({ baseExitCode: 1, afterExitCode: 1, baseExcerpt: '1 failed', afterExcerpt: '2 failed' }), verdict(GREEN_AFTER)])
    expect(another.result.status).toBe('done')
    expect(another.result.attempts.map(attempt => attempt.outcome)).toEqual(['acceptance not witnessed', 'passed'])
    expect(another.calls.implementer).toBe(2)

    expect(await outcomeOf({ baseExitCode: 1, afterExitCode: 1, baseExcerpt: '' })).toBe('acceptance not witnessed')
    expect(await outcomeOf({ baseExitCode: 1, afterExitCode: 2, baseExcerpt: 'x', afterExcerpt: 'x' })).toBe('acceptance not witnessed')

    const unrun = await run([verdict({ baseExitCode: 1, afterExitCode: 1, baseExcerpt: 'x', afterExcerpt: 'x' }, 'f'.repeat(64)), verdict(GREEN_AFTER)])
    expect(unrun.result.status).toBe('done')
    expect(unrun.result.attempts.map(attempt => attempt.outcome)).toEqual(['witness not run verbatim', 'passed'])
  })

  it('a shell that cannot run the witness after the change makes it invalid', async () => {
    for (const afterExitCode of [126, 127])
      expect(await outcomeOf({ baseExitCode: 1, afterExitCode, baseExcerpt: '1 failed', afterExcerpt: 'bash: pnpm: command not found' })).toBe('witness invalid')
    expect(await outcomeOf({ baseExitCode: 1, afterExitCode: 2, baseExcerpt: '1 failed', afterExcerpt: 'witness-1.sh: line 1: syntax error near unexpected token' })).toBe('witness invalid')

    expect(await outcomeOf({ baseExitCode: 1, afterExitCode: 1, baseExcerpt: '1 failed', afterExcerpt: 'witness-1.sh: line 1: syntax error near unexpected token' })).toBe('acceptance not witnessed')
    expect(await outcomeOf({ baseExitCode: 1, afterExitCode: 2, baseExcerpt: '1 failed', afterExcerpt: 'usage: rule <file>' })).toBe('acceptance not witnessed')
  })

  it('temporary paths do not make two failures differ', async () => {
    const both = (baseExcerpt: string, afterExcerpt: string): Promise<string> => outcomeOf({ baseExitCode: 1, afterExitCode: 1, baseExcerpt, afterExcerpt })

    expect(await both('Error at /var/folders/ab/cd/T/tmp.AAAA/witness-1.sh', 'Error at /var/folders/ab/cd/T/tmp.BBBB/witness-1.sh')).toBe('witness invalid')
    expect(await both('open \'/tmp/wcc-111/brief.md\' failed', 'open \'/private/tmp/wcc-222/brief.md\' failed')).toBe('witness invalid')

    expect(await both('Error at /Users/a/repo/rule.ts', 'Error at /Users/b/repo/rule.ts')).toBe('acceptance not witnessed')
    expect(await both('Error at /Users/a/tmp/one.ts', 'Error at /Users/a/tmp/two.ts')).toBe('acceptance not witnessed')
    expect(await both('Error at /tmp/wcc-111: no rule', 'Error at /tmp/wcc-222: no reader')).toBe('acceptance not witnessed')
  })
})
