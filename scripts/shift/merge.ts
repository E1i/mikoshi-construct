import type { DatabaseSync } from 'node:sqlite'
import type { Decision } from '../../src/card/grammar.js'
import type { GhRunner } from '../board/gh.js'
import type { GitRunner } from '../ghosts/sketch.js'
import type { StatusPublisher } from '../ghosts/verdict.js'
import type { OwnerMergeKind } from '../shredder/reader.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readBodyCard } from '../../src/card/grammar.js'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { MERGE_DONE } from '../bus/executor.js'
import { POLICY_DENIED } from '../bus/inbox.js'
import { reviewCarry } from '../ghosts/review-carry.js'
import { ghStatusPublisher, publishReasons, REVIEW_CARRY_EVENT, reviewStatus } from '../ghosts/verdict.js'
import { matchGlob } from '../shredder/glob.js'
import { GHOSTS_FILES, readGhostsFiles, readOwnerMergeKinds } from '../shredder/reader.js'
import { GHOST_JOURNAL, REPO } from './places.js'

export const PREFIX = '[shift:merge] '
export const USAGE = 'usage: pnpm shift:merge <pull request number>'
export const OWNER_MERGES_ON_MAIN = 'origin/main:architecture/owner-merges.md'
export const GHOSTS_FILES_ON_MAIN = `origin/main:${GHOSTS_FILES}`
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

export function isListed(file: string, ghostsFilesText: string): boolean {
  return readGhostsFiles(ghostsFilesText).some(row => row.file === file)
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
  return { stdout: [], stderr: [`${PREFIX}${message}; not handed to the bus`], exitCode: 1 }
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
  const card = readBodyCard(view.body)
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
  return { stdout: [`${PREFIX}decision auto, no owner path — PR #${number} goes to the bus at ${head}; the chain waits for its ${MERGE_DONE}`], stderr: [], exitCode: 0 }
}

export const HANDED_TO_THE_BUS = /PR #(\d+) goes to the bus at ([0-9a-f]+)/

export type BusMerge
  = | { kind: 'merged', commit: string, rule: string }
    | { kind: 'denied', rule: string, detail: string }
    | { kind: 'waiting' }

const BUS_MERGE_RECORD = `
  SELECT type, payload FROM events
  WHERE pr = ? AND head = ? AND (type = '${MERGE_DONE}' OR (type = '${POLICY_DENIED}' AND json_extract(payload, '$.command') = 'merge' AND json_extract(payload, '$.kind') = 'authority'))
  ORDER BY CASE type WHEN '${MERGE_DONE}' THEN 0 ELSE 1 END, id DESC LIMIT 1
`

export function busMerge(db: DatabaseSync, pr: number, head: string): BusMerge {
  const row = db.prepare(BUS_MERGE_RECORD).get(pr, head) as { type: string, payload: string } | undefined
  if (row === undefined)
    return { kind: 'waiting' }
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  if (row.type === MERGE_DONE)
    return { kind: 'merged', commit: String(payload.commit), rule: String(payload.rule) }
  return { kind: 'denied', rule: String(payload.rule), detail: String(payload.detail) }
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

function prReviewEvent(review: PrReview, now: Date): Record<string, unknown> {
  return { event: PR_REVIEW_EVENT, task: review.task, pr: review.pr, verdict: review.verdict, commit: review.commit, ts: now.toISOString() }
}

export function prReviewLine(review: PrReview, now: Date): string {
  return `${JSON.stringify(prReviewEvent(review, now))}\n`
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
  const card = readBodyCard(view.body)
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
  publish?: StatusPublisher
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
  const now = deps.now()
  deps.append(deps.journal, prReviewLine(review, now))
  const recorded = `${VERDICT_PREFIX}#${review.task} PR #${review.pr} ${review.verdict} at ${review.commit}; a chain arms its auto-merge only after a pass at its head, and only at ${review.commit}`
  const unposted = deps.publish === undefined ? [] : publishReasons(deps.publish, reviewStatus(prReviewEvent(review, now)))
  return { stdout: [recorded], stderr: unposted.map(reason => `${VERDICT_PREFIX}${reason}`), exitCode: unposted.length > 0 ? 1 : 0 }
}

export const CARRY_FLAG = '--carry'
export const CARRY_USAGE = `usage: pnpm shift:merge <pull request number> ${CARRY_FLAG}`
const CARRY_PREFIX = '[shift:carry] '
const ORIGIN_MAIN = 'origin/main'

export interface CarryDeps {
  gh: GhRunner
  git: GitRunner
  fetch: (number: string) => void
  journal: () => string | null
  main: string
  publish: StatusPublisher
}

function carryRefused(message: string): MergeResult {
  return { stdout: [], stderr: [`${CARRY_PREFIX}${message}; nothing published`], exitCode: 1 }
}

export function runCarry(argv: string[], deps: CarryDeps): MergeResult {
  const number = argv.find(arg => arg !== CARRY_FLAG)
  if (argv.length !== 2 || !argv.includes(CARRY_FLAG) || number === undefined || !/^\d+$/.test(number))
    return carryRefused(CARRY_USAGE)
  let view: PrView
  try {
    view = readPrView(deps.gh, number)
  }
  catch (error) {
    return carryRefused(`PR #${number} not read: ${firstLine(error)}`)
  }
  const card = readBodyCard(view.body)
  if (card.kind === 'refused')
    return carryRefused(`the first line of PR #${number} is not the task's card (${card.reason})`)
  const task = String(card.card.id)
  const review = latestPrReview(deps.journal(), task, Number(number))
  if (review === undefined)
    return carryRefused(`PR #${number} has no review verdict to carry: review it with pnpm shift:merge ${number} ${VERDICT_FLAG}`)
  const head = view.headRefOid
  if (review.commit === head)
    return { stdout: [`${CARRY_PREFIX}PR #${number} review ${review.verdict} already stands at its head ${head}; nothing to carry`], stderr: [], exitCode: 0 }
  try {
    deps.fetch(number)
  }
  catch (error) {
    return carryRefused(`main and the head of PR #${number} not fetched: ${firstLine(error)}`)
  }
  const carry = reviewCarry(deps.git, review.commit, head, deps.main)
  if (!carry.ok)
    return carryRefused(`PR #${number} needs a new review at ${head}: ${carry.reason}`)
  const status = reviewStatus({ event: REVIEW_CARRY_EVENT, task, verdict: review.verdict, from: review.commit, to: head })
  try {
    deps.publish(status)
  }
  catch (error) {
    return { stdout: [], stderr: [`${CARRY_PREFIX}the review of PR #${number} carries to ${head}, but the ${status.context} status was not posted: ${firstLine(error)}`], exitCode: 1 }
  }
  return { stdout: [`${CARRY_PREFIX}PR #${number} review ${review.verdict} carried from ${review.commit} to ${head} across ${carry.merges.length} clean update-branch merge(s)`], stderr: [], exitCode: 0 }
}

function realCarryDeps(journal: string): CarryDeps {
  const git: GitRunner = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return {
    gh: execGh,
    git,
    fetch: number => git(['fetch', '-q', 'origin', 'main', `pull/${number}/head`]),
    journal: () => existsSync(journal) ? readFileSync(journal, 'utf8') : null,
    main: ORIGIN_MAIN,
    publish: ghStatusPublisher(process.cwd()),
  }
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
  const result = argv.includes(CARRY_FLAG)
    ? runCarry(argv, realCarryDeps(journal))
    : argv.includes(VERDICT_FLAG) ? runVerdict(argv, { gh: execGh, journal, append: appendFileSync, now: () => new Date(), publish: ghStatusPublisher(process.cwd()) }) : runMerge(argv, realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
