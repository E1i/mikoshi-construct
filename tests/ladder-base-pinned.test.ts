import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'
const SCRIPT = 'scripts/construct/check-acceptance.mjs'

const CRITERION = 'the rule rejects the case'
const COMMAND = 'pnpm vitest run tests/rule.test.ts'
const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'
const MOVED_SHA = 'ab097ee5b0e1c2d3f4a5b6c7d8e9f00112233445'

interface Handle {
  argsPath: string
  argsSha256: string
  witnessDigests: { criterion: string, sha256: string }[]
  [key: string]: unknown
}

interface LadderResult {
  status: string
  attempts: { rung: number, outcome: string, reason: string }[]
  validationError?: string
}

interface Call {
  agentType: string
  prompt: string
}

type Agents = Record<string, Record<string, unknown>[]>

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function builtHandle(): Handle {
  const directory = mkdtempSync(path.join(tmpdir(), 'ladder-base-pinned-'))
  directories.push(directory)
  const agreed = path.join(directory, 'agreed.txt')
  writeFileSync(agreed, [
    'Pin the base.',
    '',
    'Effort: low — one comparison.',
    '',
    `Acceptance: ${CRITERION} — witness: \`${COMMAND}\``,
    '',
    'Invariants: the harness is green',
    '',
  ].join('\n'))
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', agreed, '--out', path.join(directory, 'args.json')], { cwd: REPO_ROOT, encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(0)
  return { ...(JSON.parse(child.stdout) as Handle), harness: { command: 'pnpm run quality' }, effort: 'low' }
}

function verdict(handle: Handle, over: Record<string, unknown>): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: ' a.ts | 2 +-',
    testsWeakened: false,
    changedFiles: ['a.ts'],
    baseSha: BASE_SHA,
    headSha: BASE_SHA,
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256: handle.argsSha256,
    witnesses: handle.witnessDigests.map(digest => ({
      criterion: digest.criterion,
      afterExitCode: 0,
      afterExcerpt: '1 passed',
      baseExitCode: 1,
      baseExcerpt: '1 failed',
      ranSha256: digest.sha256,
    })),
    ...over,
  }
}

function preflight(handle: Handle): Record<string, unknown> {
  return verdict(handle, { changedFiles: [], diffStat: '', witnesses: [] })
}

function red(handle: Handle, over: Record<string, unknown> = {}): Record<string, unknown> {
  return verdict(handle, { passed: false, failureExcerpt: 'vitest failed', witnesses: [], ...over })
}

async function run(handle: Handle, verifies: Record<string, unknown>[]): Promise<{ result: LadderResult, calls: Call[] }> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  const calls: Call[] = []
  const queues: Agents = { harness: [preflight(handle), ...verifies] }
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, prompt })
    if (options.agentType === 'implementer')
      return { status: 'done', summary: 's', files: ['a.ts'], harnessTail: 'ok', question: '' }
    const next = queues[options.agentType]?.shift()
    if (next == null)
      throw new Error(`no ${options.agentType} left in this run`)
    return next
  }
  const result = await new AsyncFunction('args', 'agent', 'log', 'phase', source)(handle, agent, () => {}, () => {})
  return { result, calls }
}

function agentTypes(calls: Call[]): string[] {
  return calls.map(call => call.agentType)
}

describe('the ladder holds the base pinned at preflight', () => {
  it('stops with base moved when HEAD is not the base after a rung', async () => {
    const handle = builtHandle()

    const { result, calls } = await run(handle, [verdict(handle, { headSha: MOVED_SHA })])

    expect(result.status).toBe('base moved')
    expect(result.validationError).toBe(`HEAD ${MOVED_SHA} is not the base ${BASE_SHA}`)
    expect(result.attempts).toEqual([{ rung: 1, effort: 'low', outcome: 'base moved', reason: result.validationError, securityFinding: '' }])
    expect(agentTypes(calls)).toEqual(['harness', 'implementer', 'harness'])
  })

  it('stops at a later rung too, with no rung after it, when an earlier rung kept the base', async () => {
    const handle = builtHandle()

    const { result, calls } = await run(handle, [red(handle), red(handle, { headSha: MOVED_SHA })])

    expect(result.status).toBe('base moved')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['harness failed', 'base moved'])
    expect(result.validationError).toContain(MOVED_SHA)
    expect(result.validationError).toContain(BASE_SHA)
    expect(agentTypes(calls)).toEqual(['harness', 'implementer', 'harness', 'implementer', 'harness'])
  })

  it('a run whose HEAD stays at the base goes on to the next rung', async () => {
    const handle = builtHandle()

    const { result, calls } = await run(handle, [red(handle), verdict(handle, {})])

    expect(result.status, JSON.stringify(result.attempts)).toBe('done')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['harness failed', 'passed'])
    expect(agentTypes(calls).filter(type => type === 'implementer')).toHaveLength(2)
  })

  it('the implementer prompt names the base and forbids moving HEAD', async () => {
    const handle = builtHandle()

    const { calls } = await run(handle, [verdict(handle, {})])
    const prompt = calls.find(call => call.agentType === 'implementer')?.prompt ?? ''

    expect(prompt).toContain(`The base is ${BASE_SHA}. Do not move HEAD: reset, checkout, rebase, stash and pull are forbidden.`)
  })

  it('the preflight and the verify prompt ask for headSha in one line that wants what git printed, not a sha from the prompt', async () => {
    const handle = builtHandle()

    const { calls } = await run(handle, [verdict(handle, {})])
    const [preflightPrompt, verifyPrompt] = calls.filter(call => call.agentType === 'harness').map(call => call.prompt)
    const line = (prompt: string | undefined): string | undefined => prompt?.split('\n').find(entry => entry.includes('headSha'))

    expect(line(preflightPrompt)).toContain('git rev-parse HEAD')
    expect(line(preflightPrompt)).toContain('never a sha this prompt names')
    expect(line(verifyPrompt)).toBe(line(preflightPrompt))
  })

  it('requires headSha in the verdict the runtime validates', () => {
    const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8')
    const literal = /^const VERDICT = (\{[\s\S]+?^\})$/m.exec(source)?.[1] ?? ''
    // eslint-disable-next-line no-new-func
    const schema = new Function(`return (${literal})`)() as { required: string[], properties: Record<string, unknown> }

    expect(schema.required).toContain('headSha')
    expect(schema.properties.headSha).toEqual({ type: 'string' })
  })
})
