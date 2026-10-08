import type { Decision } from '../../src/card/grammar.js'
import type { GhRunner } from '../board/gh.js'
import type { OwnerMergeKind } from '../shredder/reader.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseCard } from '../../src/card/grammar.js'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { matchGlob } from '../shredder/glob.js'
import { readOwnerMergeKinds, readPlainPaths } from '../shredder/reader.js'
import { GHOST_JOURNAL, REPO } from './places.js'

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

export function isListed(file: string, ownerMergesText: string): boolean {
  return ownerPaths([file], readOwnerMergeKinds(ownerMergesText)).length > 0 || readPlainPaths(ownerMergesText).includes(file)
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

export function readPrView(gh: GhRunner, number: string): PrView {
  return JSON.parse(gh(['pr', 'view', number, '-R', REPO, '--json', 'body,headRefOid,files'])) as PrView
}

export function changedFiles(gh: GhRunner, number: string): string[] {
  try {
    return (readPrView(gh, number).files ?? []).map(file => file.path)
  }
  catch {
    return []
  }
}

export function runMerge(argv: string[], deps: MergeDeps, reviewed?: string): MergeResult {
  const number = argv[0]
  if (argv.length !== 1 || number === undefined || !/^\d+$/.test(number))
    return refuse(USAGE)
  let view: PrView
  try {
    view = readPrView(deps.gh, number)
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
  const head = reviewed ?? view.headRefOid
  try {
    deps.gh(['pr', 'merge', number, '--auto', '--squash', '--match-head-commit', head, '-R', REPO])
  }
  catch (error) {
    return refuse(`gh pr merge failed: ${firstLine(error)}`)
  }
  return { stdout: [`${PREFIX}decision auto, no owner path — auto-merge armed on PR #${number} at ${head}`], stderr: [], exitCode: 0 }
}

export const PR_REVIEW_EVENT = 'pr-review'
export const REVIEW_VERDICTS = ['pass', 'changes'] as const

export type ReviewVerdict = typeof REVIEW_VERDICTS[number]

export interface PrReview {
  task: string
  pr: number
  verdict: ReviewVerdict
  commit: string
}

export function prReviewLine(review: PrReview, now: Date): string {
  return `${JSON.stringify({ event: PR_REVIEW_EVENT, task: review.task, pr: review.pr, verdict: review.verdict, commit: review.commit, ts: now.toISOString() })}\n`
}

function asReview(line: string): PrReview | undefined {
  try {
    const entry = JSON.parse(line) as Partial<PrReview> & { event?: unknown } | null
    if (entry?.event !== PR_REVIEW_EVENT || typeof entry.task !== 'string' || typeof entry.pr !== 'number' || typeof entry.commit !== 'string' || !(REVIEW_VERDICTS as readonly unknown[]).includes(entry.verdict))
      return undefined
    return { task: entry.task, pr: entry.pr, verdict: entry.verdict!, commit: entry.commit }
  }
  catch {
    return undefined
  }
}

export function latestPrReview(journal: string | null, task: string, pr: number): PrReview | undefined {
  return (journal ?? '').split('\n').map(asReview).filter(review => review?.task === task && review.pr === pr).at(-1)
}

export function passedAt(review: PrReview | undefined, head: string): boolean {
  return review?.verdict === 'pass' && review.commit === head
}

export function readPrReview(gh: GhRunner, number: number, verdict: ReviewVerdict, commit: string): PrReview | string {
  let view: { body?: unknown, headRefOid?: unknown } | null
  try {
    view = JSON.parse(gh(['pr', 'view', String(number), '-R', REPO, '--json', 'body,headRefOid,files'])) as typeof view
  }
  catch (error) {
    return `PR #${number} not read: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]!}`
  }
  if (typeof view?.body !== 'string' || typeof view.headRefOid !== 'string')
    return `PR #${number} not read: gh returned no body and head`
  if (view.headRefOid !== commit)
    return `PR #${number} head is ${view.headRefOid}, not ${commit}`
  const card = parseCard(view.body.split('\n')[0]!.trim())
  if (card.kind === 'refused')
    return `the first line of PR #${number} is not the task's card (${card.reason})`
  return { task: String(card.card.id), pr: number, verdict, commit }
}

export const VERDICT_FLAG = '--verdict'
export const COMMIT_FLAG = '--commit'
export const VERDICT_USAGE = `usage: pnpm shift:merge <pull request number> ${VERDICT_FLAG} <${REVIEW_VERDICTS.join('|')}> ${COMMIT_FLAG} <sha>`
const SHA = /^[0-9a-f]{7,40}$/
const VERDICT_PREFIX = '[shift:verdict] '

export interface VerdictDeps {
  gh: GhRunner
  journal: string
  append: (file: string, text: string) => void
  now: () => Date
}

export function runVerdict(argv: string[], deps: VerdictDeps): MergeResult {
  const at = argv.indexOf(VERDICT_FLAG)
  const commitAt = argv.indexOf(COMMIT_FLAG)
  const flagged = [at, at + 1, commitAt, commitAt + 1]
  const verdict = argv[at + 1]
  const commit = argv[commitAt + 1]
  const number = argv.find((_, index) => !flagged.includes(index))
  if (argv.length !== 5 || commitAt === -1 || commit === undefined || !SHA.test(commit) || number === undefined || !/^\d+$/.test(number) || !(REVIEW_VERDICTS as readonly (string | undefined)[]).includes(verdict))
    return { stdout: [], stderr: [`${VERDICT_PREFIX}${VERDICT_USAGE}; nothing recorded`], exitCode: 1 }
  const review = readPrReview(deps.gh, Number(number), verdict as ReviewVerdict, commit)
  if (typeof review === 'string')
    return { stdout: [], stderr: [`${VERDICT_PREFIX}${review}; nothing recorded`], exitCode: 1 }
  deps.append(deps.journal, prReviewLine(review, deps.now()))
  return { stdout: [`${VERDICT_PREFIX}#${review.task} PR #${review.pr} ${review.verdict} at ${review.commit}; a chain arms its auto-merge only after a pass at its head, and only at ${review.commit}`], stderr: [], exitCode: 0 }
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
  const argv = process.argv.slice(2)
  const journal = path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
  const result = argv.includes(VERDICT_FLAG) ? runVerdict(argv, { gh: execGh, journal, append: appendFileSync, now: () => new Date() }) : runMerge(argv, realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
