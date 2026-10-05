import type { Decision } from '../../src/card/grammar.js'
import type { GhRunner } from '../board/gh.js'
import type { OwnerMergeKind } from '../shredder/reader.js'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseCard } from '../../src/card/grammar.js'
import { execGh } from '../board/gh.js'
import { matchGlob } from '../shredder/glob.js'
import { readOwnerMergeKinds } from '../shredder/reader.js'
import { REPO } from './places.js'

export const PREFIX = '[shift:merge] '
export const USAGE = 'usage: pnpm shift:merge <pull request number>'
export const OWNER_MERGES_ON_MAIN = 'origin/main:architecture/owner-merges.md'
export const MATRIX_COUNT_LINE = /■ \d+ □ \d+ · \d+/
const MATRIX_REQUIRED_UNDER = ['src/', 'templates/']

export type MergeVerdict
  = | { kind: 'arm' }
    | { kind: 'owner-decision' }
    | { kind: 'owner-paths', paths: string[] }

export interface MergeDeps {
  gh: GhRunner
  ownerMergesText: () => string
}

export interface MergeResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

interface PrView {
  body: string
  headRefOid: string
  files: { path: string }[] | null
}

export function ownerPaths(files: string[], kinds: OwnerMergeKind[]): string[] {
  return files.filter(file => kinds.some(kind => kind.globs.some(glob => matchGlob(glob, file)))).sort()
}

export function mergeVerdict(decision: Decision, files: string[], kinds: OwnerMergeKind[]): MergeVerdict {
  if (decision !== 'auto')
    return { kind: 'owner-decision' }
  const paths = ownerPaths(files, kinds)
  return paths.length === 0 ? { kind: 'arm' } : { kind: 'owner-paths', paths }
}

export function pathWithoutMatrix(body: string, files: string[]): string | undefined {
  return MATRIX_COUNT_LINE.test(body) ? undefined : files.find(file => MATRIX_REQUIRED_UNDER.some(root => file.startsWith(root)))
}

function refuse(message: string): MergeResult {
  return { stdout: [], stderr: [`${PREFIX}${message}; auto-merge not armed`], exitCode: 1 }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

export function runMerge(argv: string[], deps: MergeDeps): MergeResult {
  const number = argv[0]
  if (argv.length !== 1 || number === undefined || !/^\d+$/.test(number))
    return refuse(USAGE)
  let view: PrView
  try {
    view = JSON.parse(deps.gh(['pr', 'view', number, '-R', REPO, '--json', 'body,headRefOid,files'])) as PrView
  }
  catch (error) {
    return refuse(`PR #${number} not read: ${firstLine(error)}`)
  }
  const card = parseCard(view.body.split('\n')[0]!.trim())
  if (card.kind === 'refused')
    return refuse(`the first line of PR #${number} is not the task's card (${card.reason})`)
  const files = (view.files ?? []).map(file => file.path)
  const unmatrixed = pathWithoutMatrix(view.body, files)
  if (unmatrixed !== undefined)
    return refuse(`PR #${number} changes ${unmatrixed} and its description has no code matrix count line ■ n □ n · n (architecture/code-matrix.md)`)
  let kinds: OwnerMergeKind[]
  try {
    kinds = readOwnerMergeKinds(deps.ownerMergesText())
  }
  catch (error) {
    return refuse(`${OWNER_MERGES_ON_MAIN} not read: ${firstLine(error)}`)
  }
  const verdict = mergeVerdict(card.card.decision, files, kinds)
  if (verdict.kind === 'owner-decision')
    return { stdout: [`${PREFIX}decision ${card.card.decision} — PR #${number} and the report, merge is Eli's`], stderr: [], exitCode: 0 }
  if (verdict.kind === 'owner-paths')
    return { stdout: verdict.paths.map(file => `${PREFIX}owner path ${file} — merge is Eli's`), stderr: [], exitCode: 0 }
  try {
    deps.gh(['pr', 'merge', number, '--auto', '--squash', '--match-head-commit', view.headRefOid, '-R', REPO])
  }
  catch (error) {
    return refuse(`gh pr merge failed: ${firstLine(error)}`)
  }
  return { stdout: [`${PREFIX}decision auto, no owner path — auto-merge armed on PR #${number} at ${view.headRefOid}`], stderr: [], exitCode: 0 }
}

function realDeps(): MergeDeps {
  return {
    gh: execGh,
    ownerMergesText: () => {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: ['ignore', 'pipe', 'pipe'] })
      return execFileSync('git', ['show', OWNER_MERGES_ON_MAIN], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    },
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runMerge(process.argv.slice(2), realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
