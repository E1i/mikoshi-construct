import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'

interface LadderResult {
  status: string
  attempts: { rung: number, effort: string, outcome: string, reason: string }[]
}

interface AgreedWitness {
  criterion: string
  command: string
  sha256: string
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)
}

const WITNESS_COUNT = 9
const VERBATIM_WITNESS = WITNESS_COUNT
const SPEC = { decision: 'd', contractChanges: '', compositionChanges: '', constraints: [], acceptance: [], files: [] }
const REPORT = { status: 'done', summary: 's', files: ['scripts/construct/check-acceptance.mjs'], harnessTail: 'ok', question: '' }

function agreedWitness(n: number): AgreedWitness {
  const command = `node -e 'const fs=require("node:fs");const bad=[];for(const f of ["AGENTS.md","CLAUDE.md"])if(fs.readFileSync(f,"utf8").includes("Contract check ${n}")===false)bad.push(f);if(bad.length>0){console.error(bad.join(" "));process.exit(1)}'`
  return { criterion: `criterion ${n} of the contract-check run`, command, sha256: crypto.createHash('sha256').update(command).digest('hex') }
}

const AGREED = Array.from({ length: WITNESS_COUNT }, (_, index) => agreedWitness(index + 1))

type Override = (witness: AgreedWitness, n: number) => Record<string, unknown>

function paraphrased(n: number): string {
  return `decoded witness-${n}.sh: node -e script building check-acceptance.mjs over constructed and attached repositories`
}

const AS_AGREED: Override = () => ({})
const CONTRACT_CHECK_RUN_RUNG_1: Override = (_witness, n) => n === VERBATIM_WITNESS ? {} : { command: paraphrased(n) }
const OTHER_SHA = 'f'.repeat(64)

function onFirst(fields: Record<string, unknown>): Override {
  return (_witness, n) => n === 1 ? fields : {}
}

function contractCheckRunVerdict(override: Override): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: ' 13 files changed, 231 insertions(+), 54 deletions(-)',
    testsWeakened: false,
    changedFiles: ['scripts/construct/check-acceptance.mjs', 'tests/check-acceptance-build.test.ts'],
    baseSha: '55d0290afce3a4321361b8f624e0fbf6f9cb8d1e',
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    witnesses: AGREED.map((witness, index) => ({
      criterion: witness.criterion,
      command: witness.command,
      afterExitCode: 0,
      afterExcerpt: '',
      baseExitCode: 1,
      baseExcerpt: `the lines of AGENTS.md, never those of CLAUDE.md: witness ${index + 1} red on the base`,
      ranSha256: witness.sha256,
      ...override(witness, index + 1),
    })),
  }
}

async function outcomes(override: Override): Promise<{ result: LadderResult, calls: Record<string, number>, outcomes: string[] }> {
  const { result, calls } = await run([contractCheckRunVerdict(override), contractCheckRunVerdict(AS_AGREED)])
  return { result, calls, outcomes: result.attempts.map(attempt => attempt.outcome) }
}

async function run(verdicts: Record<string, unknown>[]): Promise<{ result: LadderResult, calls: Record<string, number> }> {
  const queues: Record<string, unknown[]> = { architect: [SPEC, SPEC], implementer: [REPORT, REPORT, REPORT], harness: [{ ...contractCheckRunVerdict(AS_AGREED), changedFiles: [], witnesses: [] }, ...verdicts] }
  const calls: Record<string, number> = { architect: 0, implementer: 0, harness: 0 }
  const agent = async (_prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls[options.agentType] += 1
    return queues[options.agentType].shift() ?? null
  }
  const result = await ladder()({
    task: 't',
    effort: 'medium',
    harness: { command: 'pnpm run quality' },
    acceptance: AGREED.map(witness => witness.criterion),
    witnesses: AGREED.map(witness => ({ criterion: witness.criterion, command: witness.command })),
    witnessDigests: AGREED.map(witness => ({ criterion: witness.criterion, base64: Buffer.from(witness.command).toString('base64'), sha256: witness.sha256 })),
  }, agent, () => {}, () => {})
  return { result, calls }
}

describe('a reported witness is matched to the agreed one by its criterion and its sha256', () => {
  it('a witness whose command was paraphrased but whose sha matches is witnessed', async () => {
    const run1 = await outcomes(CONTRACT_CHECK_RUN_RUNG_1)
    expect(run1.result.status).toBe('done')
    expect(run1.outcomes).toEqual(['passed'])
    expect(run1.calls).toEqual({ architect: 0, implementer: 1, harness: 2 })

    const invalid = await outcomes(onFirst({ command: paraphrased(1), afterExitCode: 1, afterExcerpt: 'the lines of AGENTS.md, never those of CLAUDE.md: witness 1 red on the base' }))
    expect(invalid.result.status).toBe('base unverified')
    expect(invalid.outcomes).toEqual(['witness invalid'])

    const environment = await outcomes(onFirst({ command: paraphrased(1), baseExitCode: 127, baseExcerpt: 'bash: pnpm: command not found' }))
    expect(environment.outcomes).toEqual(['base environment'])

    expect((await outcomes(onFirst({ command: paraphrased(1), afterExitCode: 1, afterExcerpt: '2 failed' }))).outcomes).toEqual(['acceptance not witnessed', 'passed'])
    expect((await outcomes(onFirst({ criterion: 'criterion 1 of another run' }))).outcomes).toEqual(['acceptance not witnessed', 'passed'])
  })

  it('a witness whose sha differs is not run verbatim, whatever command it reports', async () => {
    for (const override of [(_witness: AgreedWitness, n: number) => n === VERBATIM_WITNESS ? {} : { command: paraphrased(n), ranSha256: OTHER_SHA }, (_witness: AgreedWitness, n: number) => n === VERBATIM_WITNESS ? {} : { ranSha256: OTHER_SHA }]) {
      const { result, calls, outcomes: seen } = await outcomes(override)
      expect(seen).toEqual(['witness not run verbatim', 'passed'])
      expect(result.attempts[0].reason).toBe(`Witness not run verbatim: ${AGREED.slice(0, VERBATIM_WITNESS - 1).map(witness => witness.criterion).join(' | ')}`)
      expect(calls.implementer).toBe(2)
    }

    expect((await outcomes(onFirst({ ranSha256: OTHER_SHA, baseExitCode: 127, baseExcerpt: 'bash: pnpm: command not found' }))).outcomes).toEqual(['witness not run verbatim', 'passed'])
    const sameFailure = { afterExitCode: 1, afterExcerpt: 'the lines of AGENTS.md, never those of CLAUDE.md: witness 2 red on the base' }
    expect((await outcomes((_witness, n) => n === 1 ? { ranSha256: OTHER_SHA } : n === 2 ? sameFailure : {})).outcomes).toEqual(['witness not run verbatim', 'passed'])
  })
})
