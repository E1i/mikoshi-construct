import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow.mjs'

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
  return { passed: true, failureExcerpt: '', securityFinding: '', diffStat: ' 1 file changed', testsWeakened: false, changedFiles, baseSha: BASE_SHA, baseInstall: INSTALLED, witnesses }
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

describe('the verify prompt gives each witness only as its base64', () => {
  it('gives three fixed lines per witness and holds neither the raw command nor base64 -d', async () => {
    const { calls } = await run({}, [green(witness())])
    const verify = calls.find(call => call.agentType === 'harness' && call !== calls[0])?.prompt ?? ''

    expect(verify).toContain(`printf %s ${BASE64} | base64 --decode > <dir>/witness-1.sh`)
    expect(verify).toContain('shasum -a 256 <dir>/witness-1.sh')
    expect(verify).toContain('bash <dir>/witness-1.sh')
    expect(verify).toContain(CRITERION)
    expect(verify).not.toContain(COMMAND)
    expect(verify).not.toContain('base64 -d')
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
