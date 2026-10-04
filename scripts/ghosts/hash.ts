import type { Sketch } from './sketch.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { canonicalImplementText, sha256Hex } from './approval.js'
import { parseSketch } from './sketch.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CHECK_ACCEPTANCE = path.join(REPO_ROOT, 'scripts/construct/check-acceptance.mjs')
const APPROVER = 'Eli'

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
  return sha256Hex(implementTextOf(briefPath))
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

function sketchNote(sketch: Sketch): string {
  return sketch.kind === 'branch' ? `sketch ${sketch.sha.slice(0, 7)}` : 'sketch none'
}

function localDate(now: Date): string {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, '0')).join('-')
}

export function approvalLine(briefPath: string, now: Date, runBuild: BuildRunner = checkAcceptanceBuild): string {
  const text = implementTextOf(briefPath)
  refuseUnlessBuilt(briefPath, text, runBuild)
  return `approved /implement text sha256: ${sha256Hex(text)} (${localDate(now)}, ${APPROVER}; ${sketchNote(parseSketch(text))})`
}

async function main(): Promise<void> {
  const briefPath = process.argv[2]
  if (briefPath === undefined) {
    console.error('usage: hash.ts <brief>')
    process.exitCode = 1
    return
  }

  try {
    console.log(approvalLine(briefPath, new Date()))
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
