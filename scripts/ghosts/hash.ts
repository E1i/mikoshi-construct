import type { Sketch } from './sketch.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { approvalSha256, canonicalImplementText } from './approval.js'
import { parseSketch } from './sketch.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CHECK_ACCEPTANCE = path.join(REPO_ROOT, 'scripts/construct/check-acceptance.mjs')
const BY_FLAG = '--by'
const USAGE = `usage: hash.ts <brief> [${BY_FLAG} <name>]`
const APPROVER_NOT_RECORDED = `approver not recorded: pass ${BY_FLAG} or set git config user.name`

export interface BuildResult { status: number | null, stderr: string }
export type BuildRunner = (implementTextPath: string) => BuildResult

export function checkAcceptanceBuild(implementTextPath: string): BuildResult {
  const result = spawnSync(process.execPath, [CHECK_ACCEPTANCE, 'build', '--brief', implementTextPath], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: result.status, stderr: result.error?.message ?? result.stderr }
}

function implementTextOf(briefPath: string): string {
  const text = canonicalImplementText(readFileSync(briefPath, 'utf8'))
  if (text === undefined)
    throw new Error(`${briefPath}: no line starting with '/implement ' in the brief`)
  return text
}

export function hashBrief(briefPath: string): string {
  return approvalSha256(implementTextOf(briefPath))
}

function firstBuildError(stderr: string): string {
  return stderr.split('\n').find(line => line.trim() !== '')?.trim() ?? 'no error printed'
}

function refuseUnlessBuilt(briefPath: string, text: string, runBuild: BuildRunner): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-hash-build-'))
  try {
    const implementTextPath = path.join(dir, 'implement.md')
    writeFileSync(implementTextPath, text)
    const result = runBuild(implementTextPath)
    if (result.status !== 0)
      throw new Error(`${briefPath}: check-acceptance build exited ${result.status ?? 'without a status'} on the /implement text, so no hash is printed: ${firstBuildError(result.stderr)}`)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function approvedSketchOf(sketch: Sketch): string {
  return sketch.kind === 'branch' ? sketch.sha : 'none'
}

function localDate(now: Date): string {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, '0')).join('-')
}

export function gitUserName(): string {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }
  catch {
    return ''
  }
}

export function resolveApprover(by: string | undefined, readGitName: () => string = gitUserName): string {
  const approver = (by ?? '').trim() || readGitName().trim()
  if (approver === '')
    throw new Error(APPROVER_NOT_RECORDED)
  return approver
}

export function approvalLine(briefPath: string, now: Date, approver: string, runBuild: BuildRunner = checkAcceptanceBuild): string {
  const text = implementTextOf(briefPath)
  refuseUnlessBuilt(briefPath, text, runBuild)
  return `approved /implement text sha256: ${approvalSha256(text)} sketch: ${approvedSketchOf(parseSketch(text))} (${localDate(now)}, ${approver})`
}

function hashArgs(argv: string[]): { briefPath: string, by: string | undefined } | null {
  const at = argv.indexOf(BY_FLAG)
  if (at !== -1 && argv[at + 1] === undefined)
    return null
  const positional = at === -1 ? argv : argv.filter((_, index) => index !== at && index !== at + 1)
  return positional.length === 1 ? { briefPath: positional[0]!, by: at === -1 ? undefined : argv[at + 1] } : null
}

async function main(): Promise<void> {
  const args = hashArgs(process.argv.slice(2))
  if (args === null) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  try {
    console.log(approvalLine(args.briefPath, new Date(), resolveApprover(args.by)))
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
