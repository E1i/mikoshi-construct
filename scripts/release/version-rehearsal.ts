import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CHANGESET_DIR, gitIn, pendingChangesets } from './changesets.js'
import { isVersionPr } from './version-pr-guard.js'

export const VERSIONED_TREE_TESTS = [
  'tests/changesets-one-line.test.ts',
  'tests/release-notes.test.ts',
  'tests/release-notes-pending.test.ts',
  'tests/docs-pending-build.test.ts',
] as const

export const WORKTREE_STEP = 'worktree'
export const VERSION_STEP = 'version-packages'
export const PRIVACY_STEP = 'privacy:check'
export const TEST_STEP = 'vitest'
export const OFFLINE_CHANGELOG = '@changesets/cli/changelog'

const CHANGESET_CONFIG = path.join(CHANGESET_DIR, 'config.json')
const OUTPUT_TAIL_LINES = 40
const VIOLATION_FILE = /^(\S+?):\d+: /m

export interface RehearsalOptions {
  root: string
  modules?: string
  tests?: readonly string[]
}

export type RehearsalVerdict
  = | { passed: true, lines: string[] }
    | { passed: false, step: string, file: string | null, lines: string[] }

interface Ran { status: number | null, output: string }

function packageManager(cwd: string, args: readonly string[]): Ran {
  const ran = spawnSync('pnpm', [...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  return { status: ran.status, output: ran.error?.message ?? `${ran.stdout}${ran.stderr}` }
}

function tail(output: string): string[] {
  return output.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).map(line => `  ${line}`)
}

function readOffline(worktree: string): void {
  const file = path.join(worktree, CHANGESET_CONFIG)
  const config = JSON.parse(readFileSync(file, 'utf8')) as { changelog?: unknown }
  writeFileSync(file, `${JSON.stringify({ ...config, changelog: OFFLINE_CHANGELOG }, null, 2)}\n`)
}

function red(step: string, file: string | null, lines: string[]): RehearsalVerdict {
  return { passed: false, step, file, lines: [`version rehearsal is red at ${step}${file === null ? '' : `, ${file}`}:`, ...lines] }
}

function versionedTreeVerdict(worktree: string, tests: readonly string[]): RehearsalVerdict {
  const version = packageManager(worktree, ['run', VERSION_STEP])
  if (version.status !== 0)
    return red(VERSION_STEP, null, tail(version.output))
  const unconsumed = pendingChangesets(readdirSync(path.join(worktree, CHANGESET_DIR)))
  if (unconsumed.length > 0)
    return red(VERSION_STEP, `${CHANGESET_DIR}/${unconsumed[0]}`, ['  the version step left these changesets unconsumed, so nothing was rehearsed:', ...unconsumed.map(file => `  ${CHANGESET_DIR}/${file}`), ...tail(version.output)])

  const privacy = packageManager(worktree, ['run', PRIVACY_STEP])
  if (privacy.status !== 0)
    return red(PRIVACY_STEP, VIOLATION_FILE.exec(privacy.output)?.[1] ?? null, tail(privacy.output))

  for (const test of tests) {
    const ran = packageManager(worktree, ['exec', TEST_STEP, 'run', test])
    if (ran.status !== 0)
      return red(TEST_STEP, test, tail(ran.output))
  }

  return {
    passed: true,
    lines: [`version rehearsal is green: ${[VERSION_STEP, PRIVACY_STEP, ...tests].join(', ')}.`],
  }
}

export function rehearseVersion({ root, modules = path.join(root, 'node_modules'), tests = VERSIONED_TREE_TESTS }: RehearsalOptions): RehearsalVerdict {
  const git = gitIn(root)
  const scratch = mkdtempSync(path.join(tmpdir(), 'construct-version-rehearsal-'))
  const worktree = path.join(scratch, 'tree')
  try {
    if (git(['worktree', 'add', '--detach', worktree, 'HEAD']) === null)
      return red(WORKTREE_STEP, null, [`  no worktree of HEAD could be added under ${scratch}`])
    symlinkSync(modules, path.join(worktree, 'node_modules'), 'dir')
    readOffline(worktree)
    return versionedTreeVerdict(worktree, tests)
  }
  finally {
    git(['worktree', 'remove', '--force', worktree])
    rmSync(scratch, { recursive: true, force: true })
    git(['worktree', 'prune'])
  }
}

function main(): void {
  const headRef = process.env.GITHUB_HEAD_REF
  if (isVersionPr(headRef)) {
    console.log(`${headRef} is the version pull request; its own tree is the versioned one, nothing to rehearse.`)
    return
  }
  const verdict = rehearseVersion({ root: process.cwd() })
  const write = verdict.passed ? console.log : console.error
  write(verdict.lines.join('\n'))
  process.exitCode = verdict.passed ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
