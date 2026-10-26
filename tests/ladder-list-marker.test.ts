import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'
const SCRIPT = 'scripts/construct/check-acceptance.mjs'
const ARGS_PATH = '.construct/implement-args.json'
const ARGS_SHA256 = 'a'.repeat(64)
const CRITERION = 'README.md has a "## Live run" heading'
const COMMAND = 'grep -q \'^## Live run\' README.md'

const DOCUMENTED_BRIEF = [
  'add a section "Live run" to README.md naming the date of this run',
  'Effort: low',
  'Acceptance:',
  `- ${CRITERION} — witness: \`${COMMAND}\``,
  'Invariants:',
  '- the harness is green',
  'Immutable:',
  '- `package.json`',
].join('\n')

interface Witness { criterion: string, command: string }
interface Digest { criterion: string, sha256: string }

interface BuiltArgs {
  acceptance: string[]
  witnesses: Witness[]
  witnessDigests: Digest[]
  invariants: string[]
  immutable: string[]
}

interface LadderResult {
  status: string
  attempts: { rung: number, effort: string, outcome: string, reason: string }[]
  validationError?: string
}

interface CheckAcceptance {
  buildArgs: (text: string) => BuiltArgs
  withoutListMarker: (criterion: string) => string
}

const { buildArgs, withoutListMarker } = await import(pathToFileURL(path.join(REPO_ROOT, SCRIPT)).href) as CheckAcceptance

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function workflowSource(): string {
  return readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8')
}

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  return new AsyncFunction('args', 'agent', 'log', 'phase', workflowSource().replace(/^export const meta = \{[\s\S]+?^\}$/m, ''))
}

function functionText(source: string, name: string): string | undefined {
  return new RegExp(`^function ${name}\\([\\s\\S]+?^\\}$`, 'm').exec(source.replace(/^export function/gm, 'function'))?.[0]
}

const REPORT = { status: 'done', summary: 's', files: ['README.md'], harnessTail: 'ok', question: '' }

function verdict(witnesses: Record<string, unknown>[]): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: ' 1 file changed, 3 insertions(+)',
    testsWeakened: false,
    changedFiles: ['README.md'],
    baseSha: '55d0290afce3a4321361b8f624e0fbf6f9cb8d1e',
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256: ARGS_SHA256,
    witnesses,
  }
}

function observed(digest: Digest, criterion: string): Record<string, unknown> {
  return { criterion, afterExitCode: 0, afterExcerpt: '', baseExitCode: 1, baseExcerpt: '', ranSha256: digest.sha256 }
}

async function runLadder(args: BuiltArgs, witnesses: Record<string, unknown>[]): Promise<{ result: LadderResult, implementerCalls: number }> {
  const queues: Record<string, unknown[]> = {
    implementer: [REPORT, REPORT, REPORT],
    harness: [{ ...verdict([]), changedFiles: [] }, verdict(witnesses), verdict(witnesses), verdict(witnesses)],
    architect: [],
  }
  let implementerCalls = 0
  const agent = async (_prompt: string, options: { agentType: string }): Promise<unknown> => {
    if (options.agentType === 'implementer')
      implementerCalls += 1
    return queues[options.agentType].shift() ?? null
  }
  const result = await ladder()({
    ...args,
    argsPath: ARGS_PATH,
    argsSha256: ARGS_SHA256,
    task: 't',
    effort: 'low',
    harness: { command: 'pnpm run quality' },
  }, agent, () => {}, () => {})
  return { result, implementerCalls }
}

describe('a criterion written as a list item in the documented brief form', () => {
  it('the build writes every criterion without its list marker', () => {
    const args = buildArgs(DOCUMENTED_BRIEF)
    expect(args.acceptance).toEqual([CRITERION])
    expect(args.witnesses).toEqual([{ criterion: CRITERION, command: COMMAND }])
    expect(args.witnessDigests.map(digest => digest.criterion)).toEqual([CRITERION])
    expect(args.invariants).toEqual(['the harness is green'])
    expect(args.immutable).toEqual(['package.json'])
  })

  it('the list marker is taken off once', () => {
    expect(withoutListMarker('- - nested')).toBe('- nested')
    expect(withoutListMarker('1. numbered')).toBe('numbered')
    expect(withoutListMarker('-not a marker')).toBe('-not a marker')
  })

  it('the build and the workflow strip the marker with the same function text', () => {
    const inBuild = functionText(readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8'), 'withoutListMarker')
    expect(inBuild).toBeDefined()
    expect(functionText(workflowSource(), 'withoutListMarker')).toBe(inBuild)
  })

  it('the documented brief is witnessed on rung 1 whether the harness copies the marker or not', async () => {
    const args = buildArgs(DOCUMENTED_BRIEF)
    for (const reported of [CRITERION, `- ${CRITERION}`]) {
      const { result, implementerCalls } = await runLadder(args, [observed(args.witnessDigests[0], reported)])
      expect(result.status).toBe('done')
      expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['passed'])
      expect(implementerCalls).toBe(1)
    }
  })

  it('args an older build wrote with the marker still match a criterion reported without it', async () => {
    const args = buildArgs(DOCUMENTED_BRIEF)
    const marked = `- ${CRITERION}`
    const older = { ...args, acceptance: [marked], witnesses: [{ criterion: marked, command: COMMAND }], witnessDigests: [{ ...args.witnessDigests[0], criterion: marked }] }
    const { result } = await runLadder(older, [observed(older.witnessDigests[0], CRITERION)])
    expect(result.status).toBe('done')
  })

  it('a fixed criterion no reported witness names stops the run on rung 1 without climbing', async () => {
    const args = buildArgs(DOCUMENTED_BRIEF)
    const { result, implementerCalls } = await runLadder(args, [observed(args.witnessDigests[0], 'another criterion')])
    expect(result.status).toBe('base unverified')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({ rung: 1, outcome: 'witness unmatched' })
    expect(result.validationError).toBe(`No reported witness names the criterion, so no rung can witness it: ${CRITERION}`)
    expect(implementerCalls).toBe(1)
  })
})
