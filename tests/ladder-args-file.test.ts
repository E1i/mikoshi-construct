import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'

interface LadderResult {
  status: string
  attempts: { rung: number, effort: string, outcome: string, reason: string }[]
  validationError?: string
  question?: string
  argsSha256?: string
  agreedSha256?: string
}

interface AgentCall {
  agentType: string
  prompt: string
  schema?: { required: string[] }
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)
}

const CRITERION = 'the item holds'
const COMMAND = 'echo args-file-marker'
const COMMAND_SHA256 = crypto.createHash('sha256').update(COMMAND).digest('hex')
const ARGS_PATH = '.construct/implement-args.json'
const ARGS_SHA256 = 'a'.repeat(64)
const OTHER_SHA256 = 'b'.repeat(64)
const AGREED_SHA256 = 'c'.repeat(64)
const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'

const REPORT = { status: 'done', summary: 's', files: ['a.ts'], harnessTail: 'ok', question: '' }
const SPEC = { decision: 'd', contractChanges: '', compositionChanges: '', constraints: [], acceptance: [CRITERION], files: [] }

function verdict(argsSha256: string, witnessed: boolean): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: ' 1 file changed',
    testsWeakened: false,
    changedFiles: witnessed ? ['a.ts', 'tests/a.test.ts'] : [],
    baseSha: BASE_SHA,
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256,
    witnesses: witnessed ? [{ criterion: CRITERION, ranSha256: COMMAND_SHA256, afterExitCode: 0, afterExcerpt: 'ok', baseExitCode: 1, baseExcerpt: '1 failed' }] : [],
  }
}

const HANDLE = {
  argsPath: ARGS_PATH,
  argsSha256: ARGS_SHA256,
  agreedSha256: AGREED_SHA256,
  hasDesign: false,
  task: 't',
  effort: 'low',
  harness: { command: 'pnpm run quality' },
  acceptance: [CRITERION],
  witnessDigests: [{ criterion: CRITERION, sha256: COMMAND_SHA256 }],
  invariants: [],
  immutable: [],
}

async function run(args: Record<string, unknown>, harness: unknown[]): Promise<{ result: LadderResult, calls: AgentCall[] }> {
  const calls: AgentCall[] = []
  const queues: Record<string, unknown[]> = { harness: [...harness], implementer: [REPORT, REPORT, REPORT, REPORT], architect: [SPEC] }
  const agent = async (prompt: string, options: { agentType: string, schema?: { required: string[] } }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, prompt, schema: options.schema })
    return queues[options.agentType].shift() ?? null
  }
  const result = await ladder()(args, agent, () => {}, () => {})
  return { result, calls }
}

describe('the harness reports the sha256 of the args file and the ladder compares it', () => {
  it('a run whose preflight reports another sha256 for the args file ends args unverified before any implementer', async () => {
    const mismatch = await run(HANDLE, [verdict(OTHER_SHA256, false), verdict(ARGS_SHA256, true)])
    const match = await run(HANDLE, [verdict(ARGS_SHA256, false), verdict(ARGS_SHA256, true)])
    const reason = `${ARGS_PATH} has sha256 ${OTHER_SHA256}, and the run was given ${ARGS_SHA256}`

    expect(mismatch.result.status).toBe('args unverified')
    expect(mismatch.calls.map(call => call.agentType)).toEqual(['harness'])
    expect(mismatch.result.attempts).toEqual([{ rung: 0, effort: 'low', outcome: 'args mismatch', reason }])
    expect(mismatch.result.validationError).toBe(reason)
    expect(match.result.status).toBe('done')
    expect(match.result.argsSha256).toBe(ARGS_SHA256)
    expect(match.result.agreedSha256).toBe(AGREED_SHA256)
  })

  it('a run whose verify reports another sha256 for the args file ends args unverified at that rung', async () => {
    const { result, calls } = await run(HANDLE, [verdict(ARGS_SHA256, false), verdict(OTHER_SHA256, true), verdict(ARGS_SHA256, true)])

    expect(result.status).toBe('args unverified')
    expect(calls.map(call => call.agentType)).toEqual(['harness', 'implementer', 'harness'])
    expect(result.attempts).toEqual([{ rung: 1, effort: 'low', outcome: 'args mismatch', reason: `${ARGS_PATH} has sha256 ${OTHER_SHA256}, and the run was given ${ARGS_SHA256}`, securityFinding: '' }])
  })
})

describe('the Workflow input is the handle', () => {
  it('the old full args, with no argsPath, are blocked before any agent', async () => {
    const { argsPath, argsSha256, ...rest } = HANDLE
    const old = await run({ ...rest, witnesses: [{ criterion: CRITERION, command: COMMAND }] }, [verdict(ARGS_SHA256, false), verdict(ARGS_SHA256, true)])
    const shortSha = await run({ ...HANDLE, argsSha256: 'abc' }, [verdict('abc', false)])

    expect(argsPath).toBe(ARGS_PATH)
    expect(argsSha256).toBe(ARGS_SHA256)
    for (const { result, calls } of [old, shortSha]) {
      expect(result.status).toBe('blocked')
      expect(calls).toEqual([])
      expect(result.question).toContain('args.argsPath')
      expect(result.question).toContain('args.argsSha256')
    }
  })
})

describe('the prompts name the args file and its sha256, never a command', () => {
  it('the verify prompt extracts each witness from the args file by its sha256 and never carries a command', async () => {
    const { calls } = await run(HANDLE, [verdict(ARGS_SHA256, false), verdict(ARGS_SHA256, true)])
    const [preflight, verify] = calls.filter(call => call.agentType === 'harness')

    expect(verify.prompt).toContain(`node scripts/construct/check-acceptance.mjs witness --args ${ARGS_PATH} --sha256 ${ARGS_SHA256} --witness-sha256 ${COMMAND_SHA256} > <dir>/witness-1.sh`)
    expect(verify.prompt).toContain('afterExitCode 2')
    for (const call of [preflight, verify]) {
      expect(call.prompt).toContain(`shasum -a 256 ${ARGS_PATH}`)
      expect(call.schema?.required).toContain('argsSha256')
      expect(call.prompt).not.toContain(COMMAND)
      expect(call.prompt).not.toContain('printf')
      expect(call.prompt).not.toContain('base64')
    }
  })

  it('the implementer and architect prompts name the args file and its sha256 for the witnesses and the design', async () => {
    const plain = await run(HANDLE, [verdict(ARGS_SHA256, false), verdict(ARGS_SHA256, true)])
    const designed = await run({ ...HANDLE, effort: 'high', hasDesign: true }, [verdict(ARGS_SHA256, false), verdict(ARGS_SHA256, true)])
    const implementer = plain.calls.find(call => call.agentType === 'implementer')?.prompt ?? ''
    const designLine = `Design from the brief: read design in ${ARGS_PATH} (sha256 ${ARGS_SHA256}) before anything else; it is the brief's Design section verbatim, and the file is pinned by that hash.`

    expect(implementer).toContain(`The commands are in ${ARGS_PATH} (sha256 ${ARGS_SHA256}, to be checked with shasum -a 256) as witnesses[]`)
    expect(implementer).toContain(CRITERION)
    expect(implementer).not.toContain(COMMAND)
    expect(implementer).not.toContain('Design from the brief')
    expect(designed.calls.find(call => call.agentType === 'implementer')?.prompt).toContain(designLine)
    expect(designed.calls.find(call => call.agentType === 'architect')?.prompt).toContain(designLine)
  })
})
