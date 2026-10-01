import { execFileSync, spawnSync } from 'node:child_process'
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
const SKETCH_BRANCH = 'sketch/demo'
const SKETCH_SHA = git(['rev-parse', 'HEAD'])
const SKETCH_TREE = git(['rev-parse', 'HEAD^{tree}'])
const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'
const OTHER_TREE = 'f'.repeat(40)

interface Handle {
  argsPath: string
  argsSha256: string
  sketch?: { branch: string, sha: string, tree: string } | null
  witnessDigests: { criterion: string, sha256: string }[]
  [key: string]: unknown
}

interface LadderResult {
  status: string
  attempts: { outcome: string, reason: string }[]
  validationError?: string
  lastFailure?: string
}

interface Preflight {
  stagedTree?: string
  unstagedPaths?: string[]
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function git(argv: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...argv], { encoding: 'utf8' }).trim()
}

function agreedText(sketchLine: string): string {
  return [
    'Start the ladder from the staged sketch (sketch).',
    sketchLine,
    '',
    'Effort: low — one comparison.',
    '',
    `Acceptance: ${CRITERION} — witness: \`${COMMAND}\``,
    '',
    'Invariants: the harness is green',
    '',
  ].join('\n')
}

function builtHandle(sketchLine: string): Handle {
  const directory = mkdtempSync(path.join(tmpdir(), 'ladder-sketch-'))
  directories.push(directory)
  const agreed = path.join(directory, 'agreed.txt')
  writeFileSync(agreed, agreedText(sketchLine))
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', agreed, '--out', path.join(directory, 'args.json')], { cwd: REPO_ROOT, encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(0)
  const handle = JSON.parse(child.stdout) as Handle
  return { ...handle, harness: { command: 'pnpm run quality' } }
}

function sketchHandle(): Handle {
  return builtHandle(`Sketch: ${SKETCH_BRANCH} @ ${SKETCH_SHA}`)
}

function preflightVerdict(handle: Handle, staged: Preflight): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: '',
    testsWeakened: false,
    changedFiles: [],
    baseSha: BASE_SHA,
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256: handle.argsSha256,
    witnesses: [],
    ...staged,
  }
}

function verifyVerdict(handle: Handle): Record<string, unknown> {
  return {
    ...preflightVerdict(handle, {}),
    changedFiles: ['a.ts'],
    diffStat: ' a.ts | 2 +-',
    witnesses: handle.witnessDigests.map(digest => ({
      criterion: digest.criterion,
      afterExitCode: 0,
      afterExcerpt: '1 passed',
      baseExitCode: 1,
      baseExcerpt: '1 failed',
      ranSha256: digest.sha256,
    })),
  }
}

async function run(handle: Handle, staged: Preflight): Promise<{ result: LadderResult, harnessPrompts: string[] }> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  const harnessPrompts: string[] = []
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    if (options.agentType === 'implementer')
      return { status: 'done', summary: 's', files: ['a.ts'], harnessTail: 'ok', question: '' }
    if (options.agentType !== 'harness')
      throw new Error(`no ${options.agentType} in this run`)
    harnessPrompts.push(prompt)
    return harnessPrompts.length === 1 ? preflightVerdict(handle, staged) : verifyVerdict(handle)
  }
  const result = await new AsyncFunction('args', 'agent', 'log', 'phase', source)(handle, agent, () => {}, () => {})
  return { result, harnessPrompts }
}

describe('the ladder starts from the sketch its brief names', () => {
  it('w1: the build carries the sketch\'s branch, sha and tree, and an index equal to the sketch\'s tree is not a red base', async () => {
    const handle = sketchHandle()
    expect(handle.sketch).toEqual({ branch: SKETCH_BRANCH, sha: SKETCH_SHA, tree: SKETCH_TREE })

    const { result, harnessPrompts } = await run(handle, { stagedTree: SKETCH_TREE, unstagedPaths: [] })

    expect(harnessPrompts[0]).not.toContain('no diff is expected')
    expect(harnessPrompts[0]).toContain(SKETCH_TREE)
    expect(result.status).not.toBe('base red')
    expect(result.status).not.toBe('base unverified')
  })

  it('w2: an index equal to the sketch with an unstaged or untracked path on top is a red base naming the path', async () => {
    const { result } = await run(sketchHandle(), { stagedTree: SKETCH_TREE, unstagedPaths: ['extra.ts'] })

    expect(result.status).toBe('base red')
    expect(result.lastFailure).toContain('extra.ts')
  })

  it('w3: an index whose tree is not the sketch\'s is an unverified base whose reason names both trees and the Sketch line', async () => {
    const { result } = await run(sketchHandle(), { stagedTree: OTHER_TREE, unstagedPaths: [] })

    expect(result.status).toBe('base unverified')
    expect(result.validationError).toBe(`sketch tree mismatch: index ${OTHER_TREE} ≠ sketch ${SKETCH_TREE} (Sketch: ${SKETCH_BRANCH} @ ${SKETCH_SHA})`)
    expect(result.attempts[0]?.reason).toBe(result.validationError)
  })

  it('w3: a preflight that reports no staged tree for a named sketch is an unverified base, never a pass', async () => {
    const { result } = await run(sketchHandle(), {})

    expect(result.status).toBe('base unverified')
    expect(result.validationError).toContain('sketch tree mismatch: index (none reported)')
  })

  it.each([
    ['Sketch: none — the brief wants an independent implementation', 'a none line'],
    ['', 'no Sketch line'],
  ])('w4: %j (%s) builds sketch null and the preflight expects no diff, as before', async (sketchLine) => {
    const handle = builtHandle(sketchLine)
    expect(handle.sketch).toBeNull()

    const { result, harnessPrompts } = await run(handle, {})

    expect(harnessPrompts[0]).toContain('no diff is expected')
    expect(result.status).not.toBe('base red')
    expect(result.status).not.toBe('base unverified')
  })

  it('w5: red-before is measured on the base sha without the sketch, and a witness red there and green on the sketch counts', async () => {
    const handle = sketchHandle()
    const { result, harnessPrompts } = await run(handle, { stagedTree: SKETCH_TREE, unstagedPaths: [] })
    const verify = harnessPrompts[1] ?? ''

    expect(verify).toContain(`git worktree add --detach "$base" ${BASE_SHA}`)
    expect(verify).not.toContain(`"$base" ${SKETCH_SHA}`)
    expect(verify).toContain(`The base is ${BASE_SHA}, without the sketch ${SKETCH_BRANCH} @ ${SKETCH_SHA}`)
    expect(result.status, JSON.stringify(result.attempts)).toBe('done')
  })
})
