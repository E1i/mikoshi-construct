import type { BumpLevel } from './declared.js'
import type { ChangeLevel, SurfaceReading } from './semantic-diff.js'
import type { Surface } from './surface.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { BUMP_LEVELS, declaredLevel, headVersion } from './declared.js'
import { cliArgs, cliEnv, failureLine, tagCli } from './json-samples.js'
import { requiredChange, SECTIONS, unbaselined } from './semantic-diff.js'
import { SURFACE_VERSION, tagSurfaceReading } from './surface.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SURFACE_FILE = 'contract/surface.json'
const UNVERSIONED_SURFACE = 1

export interface RefReading {
  reading: SurfaceReading
  note: string
}

export interface TagObserver {
  install: (worktree: string) => void
  run: (worktree: string) => void
  observe: (worktree: string) => SurfaceReading
}

export type Role = 'base' | 'head'

export type GenerateReading = (why: string) => RefReading

export function baseTag(root: string): string {
  return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function gitShow(root: string, ref: string, file: string): string {
  return execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function tagSurface(root: string, tag: string): unknown {
  try {
    return JSON.parse(gitShow(root, tag, SURFACE_FILE)) as unknown
  }
  catch {
    return null
  }
}

function surfaceVersionOf(recorded: object): number {
  return 'surfaceVersion' in recorded && typeof recorded.surfaceVersion === 'number' ? recorded.surfaceVersion : UNVERSIONED_SURFACE
}

function wholeReadingUnbaselined(reason: string): SurfaceReading {
  return Object.fromEntries(SECTIONS.map(section => [section, unbaselined(reason)])) as SurfaceReading
}

export function refReading(recorded: unknown, ref: string, role: Role, generate: GenerateReading): RefReading {
  if (recorded == null || typeof recorded !== 'object')
    return generate(`${ref} carries no ${SURFACE_FILE}`)
  const version = surfaceVersionOf(recorded)
  if (version !== SURFACE_VERSION)
    return generate(`${ref} carries ${SURFACE_FILE} of surfaceVersion ${version}, this generator writes ${SURFACE_VERSION}`)
  return { reading: recorded as SurfaceReading, note: `${ref} carries ${SURFACE_FILE} of surfaceVersion ${SURFACE_VERSION}: it is the ${role}` }
}

function failedStep(worktree: string, observer: TagObserver): string | null {
  try {
    observer.install(worktree)
  }
  catch (error) {
    return `the tag's CLI did not install (pnpm install --frozen-lockfile): ${failureLine(error)}`
  }
  try {
    observer.run(worktree)
  }
  catch (error) {
    return `the tag's CLI did not run (--help): ${failureLine(error)}`
  }
  return null
}

function removeWorktree(root: string, worktree: string): void {
  if (existsSync(worktree))
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' })
}

export function generatedFromCode(root: string, tag: string, role: Role, why: string, observer: TagObserver): RefReading {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-base-')))
  const worktree = path.join(scratch, 'tree')
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, tag], { cwd: root, stdio: 'ignore' })
    const failed = failedStep(worktree, observer)
    if (failed != null)
      return { reading: wholeReadingUnbaselined(failed), note: `${why}; ${failed}: the whole ${role} is unbaselined` }
    return { reading: observer.observe(worktree), note: `${why}: the ${role} is generated from ${tag}'s code` }
  }
  finally {
    removeWorktree(root, worktree)
    rmSync(scratch, { recursive: true, force: true })
  }
}

export const TAG_CLI: TagObserver = {
  install: worktree => execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] }),
  run: (worktree) => {
    const home = mkdtempSync(path.join(tmpdir(), 'construct-run-'))
    try {
      execFileSync(process.execPath, cliArgs(tagCli(worktree), ['--help']), { env: cliEnv(home), stdio: ['ignore', 'pipe', 'pipe'] })
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
  observe: tagSurfaceReading,
}

export function requiredLevel(change: ChangeLevel, version: string): BumpLevel {
  const beforeOne = Number(version.split('.')[0]) === 0
  if (change === 'none')
    return 'none'
  if (change === 'additive')
    return beforeOne ? 'patch' : 'minor'
  return beforeOne ? 'minor' : 'major'
}

export function isWeaker(declared: BumpLevel, required: BumpLevel): boolean {
  return BUMP_LEVELS.indexOf(declared) < BUMP_LEVELS.indexOf(required)
}

function readingAt(root: string, ref: string, role: Role): RefReading {
  return refReading(tagSurface(root, ref), ref, role, why => generatedFromCode(root, ref, role, why, TAG_CLI))
}

function requiredLines(tag: string, reading: RefReading, head: SurfaceReading, version: string): { required: BumpLevel, lines: string[] } {
  const change = requiredChange(reading.reading, head)
  const required = requiredLevel(change.level, version)
  return {
    required,
    lines: [
      `[contract:bump] base ${tag}: ${reading.note}`,
      `required: ${required} (${change.level} surface change)`,
      ...change.reasons.map(reason => `  ${reason}`),
    ],
  }
}

function runPair(root: string, baseRef: string, headRef: string): number {
  const head = readingAt(root, headRef, 'head')
  const version = (JSON.parse(gitShow(root, headRef, 'package.json')) as { version: string }).version
  const { lines } = requiredLines(baseRef, readingAt(root, baseRef, 'base'), head.reading, version)
  console.warn([...lines, `head ${headRef}: ${head.note}`, `head ${headRef}: the declared level is not compared for an explicit --base/--head pair`].join('\n'))
  return 0
}

function run(root: string): number {
  const tag = baseTag(root)
  const head = JSON.parse(readFileSync(path.join(root, SURFACE_FILE), 'utf8')) as Surface
  const { required, lines } = requiredLines(tag, readingAt(root, tag, 'base'), head, headVersion(root))
  const declared = declaredLevel(root, tag)
  lines.splice(2, 0, `declared: ${declared}`)
  if (isWeaker(declared, required)) {
    console.error([...lines, `declared ${declared} is weaker than required ${required}: add a changeset of level ${required} for mikoshi-construct`].join('\n'))
    return 1
  }
  console.warn(lines.join('\n'))
  return 0
}

function main(): number {
  const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } })
  if (values.base == null && values.head == null)
    return run(REPO_ROOT)
  if (values.base == null || values.head == null)
    throw new Error('--base and --head go together: give both or neither')
  return runPair(REPO_ROOT, values.base, values.head)
}

if (process.argv[1]?.endsWith('bump.ts'))
  process.exit(main())
