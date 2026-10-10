import type { GhRunner } from '../board/gh.js'
import type { OwnerMergeKind } from '../shredder/reader.js'
import type { CarryDeps, MergeResult } from './merge.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseCard } from '../../src/card/grammar.js'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { HEAD_READS } from '../bus/update-executor.js'
import { blockFor, SETTLE_MS } from '../bus/update-worker.js'
import { ghStatusPublisher } from '../ghosts/verdict.js'
import { readOwnerMergeKinds } from '../shredder/reader.js'
import { latestPrReview, mergeVerdict, OWNER_MERGES_ON_MAIN, readPrView, runCarry } from './merge.js'
import { GHOST_JOURNAL, REPO } from './places.js'

export const PREFIX = '[shift:current] '
export const READY_FOR_OWNER_EVENT = 'ready-for-owner'
export const REVIEW_MISSING_EVENT = 'review-missing'
export const REVIEW_MISSING_AFTER_MS = 15 * 60 * 1000
const GREEN_CONCLUSIONS: readonly unknown[] = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const PR_FIELDS = 'number,createdAt,headRefOid,mergeStateStatus,autoMergeRequest,statusCheckRollup,body,files'
const REVIEW_CONTEXT = 'review'

export interface CurrentDeps {
  gh: GhRunner
  carry: CarryDeps
  ownerMergesText: () => string
  journal: () => string | null
  append: (text: string) => void
  now: () => Date
  settle: () => void
}

interface Check {
  context?: string
  name?: string
  state?: string
  conclusion?: string
  startedAt?: string
  completedAt?: string
}

interface OpenPr {
  number: number
  createdAt: string
  headRefOid: string
  mergeStateStatus: string
  autoMergeRequest: object | null
  statusCheckRollup: Check[] | null
  body: string
  files: { path: string }[] | null
}

interface Kept {
  pr: OpenPr
  task: string
  ownerMerge: boolean
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

function reviewed(pr: OpenPr): boolean {
  return (pr.statusCheckRollup ?? []).some(check => check.context === REVIEW_CONTEXT && check.state === 'SUCCESS')
}

function kept(pr: OpenPr, kinds: OwnerMergeKind[]): Kept | undefined {
  if (!reviewed(pr))
    return undefined
  const card = parseCard(pr.body.split('\n')[0]!.trim())
  if (card.kind === 'refused')
    return undefined
  const armed = pr.autoMergeRequest !== null
  const verdict = mergeVerdict(card.card.decision, (pr.files ?? []).map(file => file.path), kinds)
  if (!armed && verdict.kind === 'arm')
    return undefined
  return { pr, task: String(card.card.id), ownerMerge: !armed }
}

function alreadyWritten(journal: string | null, event: string, number: number, head: string): boolean {
  return (journal ?? '').split('\n').some((line) => {
    try {
      const entry = JSON.parse(line) as { event?: unknown, pr?: unknown, head?: unknown } | null
      return entry?.event === event && entry.pr === number && entry.head === head
    }
    catch {
      return false
    }
  })
}

function readyLine(item: Kept, now: Date): string {
  const { number, headRefOid } = item.pr
  const command = `gh pr merge ${number} --squash --match-head-commit ${headRefOid}`
  return `${JSON.stringify({ event: READY_FOR_OWNER_EVENT, task: item.task, pr: number, head: headRefOid, command, ts: now.toISOString() })}\n`
}

function greenSince(pr: OpenPr): number | undefined {
  const ci = (pr.statusCheckRollup ?? []).filter(check => check.context !== REVIEW_CONTEXT)
  if (ci.length === 0 || !ci.every(check => check.state === 'SUCCESS' || GREEN_CONCLUSIONS.includes(check.conclusion)))
    return undefined
  return Math.max(...ci.map(check => Date.parse(check.completedAt ?? check.startedAt ?? '')))
}

function reviewMissing(pr: OpenPr, journal: string | null, now: Date): string | undefined {
  if ((pr.statusCheckRollup ?? []).some(check => check.context === REVIEW_CONTEXT))
    return undefined
  const card = parseCard(pr.body.split('\n')[0]!.trim())
  if (card.kind === 'refused')
    return undefined
  const task = String(card.card.id)
  if (latestPrReview(journal, task, pr.number)?.commit === pr.headRefOid)
    return undefined
  const since = greenSince(pr)
  if (since === undefined || Number.isNaN(since) || now.getTime() - since <= REVIEW_MISSING_AFTER_MS)
    return undefined
  if (alreadyWritten(journal, REVIEW_MISSING_EVENT, pr.number, pr.headRefOid))
    return undefined
  return task
}

function reviewMissingLine(task: string, pr: OpenPr, now: Date): string {
  return `${JSON.stringify({ event: REVIEW_MISSING_EVENT, task, pr: pr.number, head: pr.headRefOid, greenSince: new Date(greenSince(pr)!).toISOString(), ts: now.toISOString() })}\n`
}

function movedHead(pr: OpenPr, deps: CurrentDeps): string | undefined {
  for (let read = 0; read < HEAD_READS; read += 1) {
    if (read > 0)
      deps.settle()
    try {
      const head = readPrView(deps.gh, String(pr.number)).headRefOid
      if (head !== pr.headRefOid)
        return head
    }
    catch {}
  }
  return undefined
}

function update(item: Kept, deps: CurrentDeps): string[] {
  const number = String(item.pr.number)
  try {
    deps.gh(['pr', 'update-branch', number, '-R', REPO])
  }
  catch (error) {
    return [`${PREFIX}PR #${number} not updated, left alone: ${firstLine(error)}`]
  }
  const head = movedHead(item.pr, deps)
  if (head === undefined)
    return [`${PREFIX}PR #${number} updated, its review not carried: its head did not move from ${item.pr.headRefOid} after ${HEAD_READS} reads`]
  const carried = runCarry([number, '--carry'], deps.carry)
  if (carried.exitCode !== 0)
    return [`${PREFIX}PR #${number} updated, its review not carried: ${carried.stderr.join(' ')}`]
  const kind = item.ownerMerge ? 'owner-merge, not armed' : 'armed'
  return [`${PREFIX}PR #${number} updated to ${head} with its review carried (${kind})`, ...carried.stdout]
}

export function runCurrent(deps: CurrentDeps): MergeResult {
  let open: OpenPr[]
  let kinds: OwnerMergeKind[]
  try {
    open = JSON.parse(deps.gh(['pr', 'list', '-R', REPO, '--state', 'open', '--limit', '200', '--json', PR_FIELDS])) as OpenPr[]
    kinds = readOwnerMergeKinds(deps.ownerMergesText())
  }
  catch (error) {
    return { stdout: [], stderr: [`${PREFIX}open pull requests not read: ${firstLine(error)}`], exitCode: 1 }
  }
  const items = open
    .map(pr => kept(pr, kinds))
    .filter((item): item is Kept => item !== undefined)
    .sort((a, b) => a.pr.createdAt.localeCompare(b.pr.createdAt))
  const stdout: string[] = []
  const journal = deps.journal()
  for (const item of items.filter(entry => entry.ownerMerge && entry.pr.mergeStateStatus === 'CLEAN' && !alreadyWritten(journal, READY_FOR_OWNER_EVENT, entry.pr.number, entry.pr.headRefOid))) {
    deps.append(readyLine(item, deps.now()))
    stdout.push(`${PREFIX}PR #${item.pr.number} is current and waits for the owner: gh pr merge ${item.pr.number} --squash --match-head-commit ${item.pr.headRefOid}`)
  }
  for (const pr of open) {
    const now = deps.now()
    const task = reviewMissing(pr, journal, now)
    if (task === undefined)
      continue
    deps.append(reviewMissingLine(task, pr, now))
    stdout.push(`${PREFIX}PR #${pr.number} head ${pr.headRefOid} has been green for more than 15 minutes with no review verdict: event:${REVIEW_MISSING_EVENT} written`)
  }
  const behind = items.find(item => item.pr.mergeStateStatus === 'BEHIND')
  if (behind === undefined)
    return { stdout: [...stdout, `${PREFIX}no kept pull request is behind`], stderr: [], exitCode: 0 }
  const lines = update(behind, deps)
  const failed = lines[0]!.includes('left alone') || lines[0]!.includes('not carried')
  return { stdout: failed ? stdout : [...stdout, ...lines], stderr: failed ? [lines[0]!] : [], exitCode: failed ? 1 : 0 }
}

export function realCurrentDeps(journalFile: string): CurrentDeps {
  const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return {
    gh: execGh,
    carry: {
      gh: execGh,
      git,
      fetch: number => git(['fetch', '-q', 'origin', 'main', `pull/${number}/head`]),
      journal: () => existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : null,
      main: 'origin/main',
      publish: ghStatusPublisher(process.cwd()),
    },
    ownerMergesText: () => {
      git(['fetch', 'origin', 'main'])
      return git(['show', OWNER_MERGES_ON_MAIN])
    },
    journal: () => existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : null,
    append: text => appendFileSync(journalFile, text),
    now: () => new Date(),
    settle: () => blockFor(SETTLE_MS),
  }
}

function ghostJournal(): string {
  return path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCurrent(realCurrentDeps(ghostJournal()))
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
