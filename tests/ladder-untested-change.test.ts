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
  effort?: string
  attempts: { rung: number, effort: string, outcome: string, reason: string }[]
  acceptance?: string[]
  invariants?: string[]
  immutable?: string[]
  changedFiles?: string[]
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

function witnessed(items: string[]): unknown[] {
  return items.map(criterion => ({ criterion, command: WITNESS_COMMAND, ranSha256: WITNESS_SHA256, baseExcerpt: '1 failed', baseExitCode: 1, afterExitCode: 0 }))
}

function fixedWitnesses(items: string[]): { criterion: string, command: string }[] {
  return items.map(criterion => ({ criterion, command: WITNESS_COMMAND }))
}

function fixedWitnessDigests(items: string[]): { criterion: string, base64: string, sha256: string }[] {
  return items.map(criterion => ({ criterion, base64: Buffer.from(WITNESS_COMMAND).toString('base64'), sha256: WITNESS_SHA256 }))
}

const INSTALLED = { command: 'pnpm install --frozen-lockfile', exitCode: 0 }
const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'

function green(changedFiles: string[]): Record<string, unknown> {
  return { passed: true, failureExcerpt: '', securityFinding: '', diffStat: ' 1 file changed', testsWeakened: false, changedFiles, baseSha: BASE_SHA, baseInstall: INSTALLED, argsSha256: ARGS_SHA256, witnesses: witnessed(DEFAULT_ACCEPTANCE) }
}

const REPORT = { status: 'done', summary: 'changed the rule', files: ['src/a.ts'], harnessTail: 'ok', question: '' }

const RED = { passed: false, failureExcerpt: 'vitest failed', securityFinding: '', diffStat: ' 1 file changed', testsWeakened: false, changedFiles: ['src/a.ts'], baseSha: BASE_SHA, baseInstall: INSTALLED, argsSha256: ARGS_SHA256, witnesses: [] }

async function run(changedFiles: string[], rungVerdicts: unknown[] = []): Promise<LadderResult> {
  const verdicts = [...rungVerdicts, ...Array.from({ length: 4 - rungVerdicts.length }, () => green(changedFiles))]
  const queues: Record<string, Reply[]> = {
    architect: [],
    implementer: [REPORT, REPORT, REPORT, REPORT],
    harness: [green(['src/a.ts']), ...verdicts],
  }
  const agent = async (_prompt: string, options: { agentType: string }): Promise<unknown> => {
    const reply = queues[options.agentType].shift()
    if (reply instanceof Error)
      throw reply
    return reply ?? null
  }
  return ladder()({ argsPath: ARGS_PATH, argsSha256: ARGS_SHA256, harness: { command: 'pnpm run quality' }, acceptance: DEFAULT_ACCEPTANCE, witnesses: fixedWitnesses(DEFAULT_ACCEPTANCE), witnessDigests: fixedWitnessDigests(DEFAULT_ACCEPTANCE), effort: 'low' }, agent, () => {}, () => {})
}

describe('a rung that changes source with no test is never done', () => {
  it('reports untested change, naming the source file, and never done', async () => {
    const result = await run(['src/a.ts'])

    expect(result.status).not.toBe('done')
    expect(result.attempts.some(attempt => attempt.outcome === 'untested change' && attempt.reason.includes('src/a.ts'))).toBe(true)
  })

  it('reports done for the same rung once a matching test file changed too', async () => {
    const result = await run(['src/a.ts', 'tests/a.test.ts'])

    expect(result.status).toBe('done')
    expect(result.attempts.some(attempt => attempt.outcome === 'untested change')).toBe(false)
  })

  it('does not hold a declaration file, and names only the source file beside it', async () => {
    const result = await run(['src/a.ts', 'src/types.d.ts'])
    const untested = result.attempts.find(attempt => attempt.outcome === 'untested change')

    expect(untested?.reason).toContain('src/a.ts')
    expect(untested?.reason).not.toContain('src/types.d.ts')
    expect((await run(['src/types.d.ts'])).status).toBe('done')
  })

  it('does not hold a file under src/ with no code extension, and names only the code file beside it', async () => {
    const result = await run(['src/a.ts', 'src/styles.css'])
    const untested = result.attempts.find(attempt => attempt.outcome === 'untested change')

    expect(untested?.reason).toContain('src/a.ts')
    expect(untested?.reason).not.toContain('src/styles.css')
    expect((await run(['src/styles.css'])).status).toBe('done')
  })

  it('does not count a fixture under tests/ as a test file', async () => {
    const result = await run(['src/a.ts', 'tests/fixtures/x.json'])

    expect(result.status).not.toBe('done')
    expect(result.attempts[0].outcome).toBe('untested change')
  })

  it('does not count a *.test file outside tests/ as a test file', async () => {
    const result = await run(['src/a.ts', 'src/a.test.ts'])

    expect(result.status).not.toBe('done')
    expect(result.attempts[0].outcome).toBe('untested change')
  })

  it('keeps harness failed for a red rung, and holds the green rung after it', async () => {
    const result = await run(['src/a.ts'], [RED])

    expect(result.attempts.slice(0, 2).map(attempt => attempt.outcome)).toEqual(['harness failed', 'untested change'])
  })
})
