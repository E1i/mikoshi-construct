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
  question?: string
}

interface AgentCall {
  agentType: string
  prompt: string
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)
}

const CRITERION = 'the verbatim item holds'
const COMMAND = 'echo verbatim-marker-271'
const SHA256 = crypto.createHash('sha256').update(COMMAND).digest('hex')
const BASE64 = Buffer.from(COMMAND, 'utf8').toString('base64')
const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'
const INSTALLED = { command: 'pnpm install --frozen-lockfile', exitCode: 0 }

const REPORT = { status: 'done', summary: 'changed the ladder', files: ['a.ts'], harnessTail: 'ok', question: '' }

function green(witnesses: unknown[], changedFiles: string[] = ['a.ts']): Record<string, unknown> {
  return { passed: true, failureExcerpt: '', securityFinding: '', diffStat: ' 1 file changed', testsWeakened: false, changedFiles, baseSha: BASE_SHA, baseInstall: INSTALLED, argsSha256: ARGS_SHA256, witnesses }
}

function witness(overrides: Record<string, unknown> = {}, drop?: string): Record<string, unknown>[] {
  const entry: Record<string, unknown> = { criterion: CRITERION, command: COMMAND, ranSha256: SHA256, baseExitCode: 1, afterExitCode: 0, baseExcerpt: '1 failed', ...overrides }
  if (drop)
    delete entry[drop]
  return [entry]
}

async function run(args: Record<string, unknown>, harnessReplies: unknown[]): Promise<{ result: LadderResult, calls: AgentCall[] }> {
  const calls: AgentCall[] = []
  const queues: Record<string, unknown[]> = {
    architect: [],
    implementer: [REPORT, REPORT, REPORT, REPORT],
    harness: [green([]), ...harnessReplies],
  }
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, prompt })
    return queues[options.agentType].shift() ?? null
  }
  const result = await ladder()({
    argsPath: ARGS_PATH,
    argsSha256: ARGS_SHA256,
    harness: { command: 'pnpm run quality' },
    task: 't',
    acceptance: [CRITERION],
    witnesses: [{ criterion: CRITERION, command: COMMAND }],
    witnessDigests: [{ criterion: CRITERION, base64: BASE64, sha256: SHA256 }],
    effort: 'low',
    ...args,
  }, agent, () => {}, () => {})
  return { result, calls }
}

async function callLadder(args: Record<string, unknown>, queueOverrides: { architect?: unknown[], implementer?: unknown[], harness?: unknown[] }): Promise<{ result: LadderResult, calls: AgentCall[] }> {
  const calls: AgentCall[] = []
  const queues: Record<string, unknown[]> = {
    architect: queueOverrides.architect ?? [],
    implementer: queueOverrides.implementer ?? [REPORT, REPORT, REPORT, REPORT],
    harness: queueOverrides.harness ?? [green([])],
  }
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, prompt })
    return queues[options.agentType].shift() ?? null
  }
  const result = await ladder()({
    argsPath: ARGS_PATH,
    argsSha256: ARGS_SHA256,
    harness: { command: 'pnpm run quality' },
    task: 't',
    acceptance: [CRITERION],
    witnesses: [{ criterion: CRITERION, command: COMMAND }],
    witnessDigests: [{ criterion: CRITERION, base64: BASE64, sha256: SHA256 }],
    effort: 'low',
    ...args,
  }, agent, () => {}, () => {})
  return { result, calls }
}

const CRITERION_B = 'the second item holds'
const COMMAND_B = 'echo verbatim-marker-271-b'
const SHA256_B = crypto.createHash('sha256').update(COMMAND_B).digest('hex')
const BASE64_B = Buffer.from(COMMAND_B, 'utf8').toString('base64')

function witnessPair(): Record<string, unknown>[] {
  return [
    { criterion: CRITERION, command: COMMAND, ranSha256: SHA256, baseExitCode: 1, afterExitCode: 0, baseExcerpt: '1 failed' },
    { criterion: CRITERION_B, command: COMMAND_B, ranSha256: SHA256_B, baseExitCode: 1, afterExitCode: 0, baseExcerpt: '1 failed' },
  ]
}

const WITNESS_DIR_LINE = 'Make <dir> once, before the first witness, with mktemp -d, and write the absolute path it printed wherever <dir> stands: it lies outside the repository, so it still resolves after the cd into the base worktree and adds no file to the working tree.'

const SPEC = { decision: 'd', contractChanges: '', compositionChanges: '', constraints: [], acceptance: [CRITERION], files: [] }

describe('a run whose witness has no digest is blocked before any agent', () => {
  it('blocks with a question naming the criterion, and proceeds to done once the digest is carried', async () => {
    const missing = await run({ witnessDigests: [] }, [green(witness())])
    const carried = await run({}, [green(witness())])

    expect(missing.result.status).toBe('blocked')
    expect(missing.calls).toEqual([])
    expect(missing.result.question).toContain(CRITERION)
    expect(carried.result.status).toBe('done')
  })
})

describe('the verify prompt extracts each witness from the args file by its sha256', () => {
  it('gives three fixed lines per witness and holds neither the raw command nor base64', async () => {
    const { calls } = await run({}, [green(witness())])
    const verify = calls.find(call => call.agentType === 'harness' && call !== calls[0])?.prompt ?? ''

    expect(verify).toContain(`node scripts/construct/check-acceptance.mjs witness --args ${ARGS_PATH} --sha256 ${ARGS_SHA256} --n 1 > <dir>/witness-1.sh`)
    expect(verify).toContain('shasum -a 256 <dir>/witness-1.sh')
    expect(verify).toContain('bash <dir>/witness-1.sh')
    expect(verify).toContain(CRITERION)
    expect(verify).not.toContain(COMMAND)
    expect(verify).not.toContain(BASE64)
    expect(verify).not.toContain('base64')
  })
})

describe('the verdict schema requires ranSha256', () => {
  it('is not done with no ranSha256, ending as witness not run verbatim, and is done with the matching one', async () => {
    const missing = await run({}, [green(witness({}, 'ranSha256'))])
    const matching = await run({}, [green(witness())])

    expect(missing.result.status).not.toBe('done')
    expect(missing.result.attempts.some(a => a.outcome === 'witness not run verbatim' && a.reason.includes(CRITERION))).toBe(true)
    expect(matching.result.status).toBe('done')
  })
})

describe('a rung whose harness ran the witness with the wrong sha256', () => {
  it('is not done and ends as witness not run verbatim naming the criterion, unlike the matching sha', async () => {
    const same = await run({}, [green(witness())])
    const other = await run({}, [green(witness({ ranSha256: '0'.repeat(64) }))])

    expect(same.result.status).toBe('done')
    expect(other.result.status).not.toBe('done')
    expect(other.result.attempts[0]).toMatchObject({ outcome: 'witness not run verbatim' })
    expect(other.result.attempts[0].reason).toContain(CRITERION)
  })
})

describe('witness not run verbatim is checked after an immutable path and before an unwitnessed acceptance', () => {
  it('reports witness not run verbatim for a wrong sha256 with an item green on the base', async () => {
    const { result } = await run({}, [green(witness({ ranSha256: '0'.repeat(64), baseExitCode: 0 }))])

    expect(result.attempts[0].outcome).toBe('witness not run verbatim')
  })

  it('reports immutable changed for an immutable path even with a wrong sha256', async () => {
    const { result } = await run({ immutable: ['a.ts'] }, [green(witness({ ranSha256: '0'.repeat(64) }))])

    expect(result.attempts[0].outcome).toBe('immutable changed')
  })
})

describe('the verify prompt makes <dir> once with mktemp -d', () => {
  it('makes <dir> once with mktemp -d, before the first witness, and never a scratch directory of its own', async () => {
    const { calls } = await callLadder({
      acceptance: [CRITERION, CRITERION_B],
      witnesses: [{ criterion: CRITERION, command: COMMAND }, { criterion: CRITERION_B, command: COMMAND_B }],
      witnessDigests: [{ criterion: CRITERION, base64: BASE64, sha256: SHA256 }, { criterion: CRITERION_B, base64: BASE64_B, sha256: SHA256_B }],
    }, { harness: [green([]), green(witnessPair())] })
    const verify = calls.filter(call => call.agentType === 'harness')[1]?.prompt ?? ''

    expect(verify.split(WITNESS_DIR_LINE).length - 1).toBe(1)
    expect(verify).not.toContain('scratch directory of your own')
  })
})

describe('the Design from the brief reaches both prompts', () => {
  it('carries the Design into the architect prompt and the implementer prompt', async () => {
    const { calls } = await callLadder({ effort: 'high', hasDesign: true }, { architect: [SPEC], implementer: [REPORT], harness: [green([]), green(witness())] })
    const architect = calls.find(call => call.agentType === 'architect')?.prompt ?? ''
    const implementer = calls.find(call => call.agentType === 'implementer')?.prompt ?? ''
    const block = `Design from the brief: read design in ${ARGS_PATH} (sha256 ${ARGS_SHA256}) before anything else`

    expect(architect).toContain(block)
    expect(implementer).toContain(block)
  })

  it('puts no Design block in either prompt without a design', async () => {
    const { calls } = await callLadder({ effort: 'high' }, { architect: [SPEC], implementer: [REPORT], harness: [green([]), green(witness())] })
    const architect = calls.find(call => call.agentType === 'architect')?.prompt ?? ''
    const implementer = calls.find(call => call.agentType === 'implementer')?.prompt ?? ''

    expect(architect).not.toContain('Design from the brief')
    expect(implementer).not.toContain('Design from the brief')
  })

  it('puts no Design block in either prompt for an empty design', async () => {
    const withoutDesign = await callLadder({ effort: 'high' }, { architect: [SPEC], implementer: [REPORT], harness: [green([]), green(witness())] })
    const emptyDesign = await callLadder({ effort: 'high', hasDesign: false }, { architect: [SPEC], implementer: [REPORT], harness: [green([]), green(witness())] })
    const archNone = withoutDesign.calls.find(call => call.agentType === 'architect')?.prompt ?? ''
    const implNone = withoutDesign.calls.find(call => call.agentType === 'implementer')?.prompt ?? ''
    const archEmpty = emptyDesign.calls.find(call => call.agentType === 'architect')?.prompt ?? ''
    const implEmpty = emptyDesign.calls.find(call => call.agentType === 'implementer')?.prompt ?? ''

    expect(archEmpty).not.toContain('Design from the brief')
    expect(implEmpty).not.toContain('Design from the brief')
    expect(archEmpty).toBe(archNone)
    expect(implEmpty).toBe(implNone)
  })
})

interface WitnessSchema {
  required: string[]
  properties: Record<string, unknown>
}

async function verifySchema(): Promise<{ witness: WitnessSchema, prompt: string }> {
  const calls: { prompt: string, options: { agentType: string, schema?: { properties: { witnesses: { items: WitnessSchema } } } } }[] = []
  const queues: Record<string, unknown[]> = { architect: [], implementer: [REPORT], harness: [green([]), green(witness())] }
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls.push({ prompt, options })
    return queues[options.agentType].shift() ?? null
  }
  await ladder()({
    argsPath: ARGS_PATH,
    argsSha256: ARGS_SHA256,
    harness: { command: 'pnpm run quality' },
    task: 't',
    acceptance: [CRITERION],
    witnesses: [{ criterion: CRITERION, command: COMMAND }],
    witnessDigests: [{ criterion: CRITERION, base64: BASE64, sha256: SHA256 }],
    effort: 'low',
  }, agent, () => {}, () => {})
  const verify = calls.filter(call => call.options.agentType === 'harness')[1]
  return { witness: verify.options.schema!.properties.witnesses.items, prompt: verify.prompt }
}

describe('the verdict schema the ladder hands the harness', () => {
  it('requires ranSha256 for every witness', async () => {
    const { witness } = await verifySchema()

    expect(witness.required).toContain('ranSha256')
  })

  it('neither requires nor asks for the witness command, which the ladder does not read', async () => {
    const { witness, prompt } = await verifySchema()

    expect(witness.required).not.toContain('command')
    expect(Object.keys(witness.properties)).not.toContain('command')
    expect(prompt).not.toMatch(/as command\b/)
  })
})
