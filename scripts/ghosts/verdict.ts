import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { readContourSchema, violations } from '../contract/contours.js'
import { approvedHashPath, extractApprovedHash } from './approval.js'
import { appendJournalEvent } from './journal.js'
import { reviewCarry } from './review-carry.js'

const JOURNAL_FILE = 'ghosts.jsonl'
const VERDICT_SCHEMA = 'review-verdict'
const JOURNAL_LINE = '#/$defs/journalLine'
const CARD_NUMBER_MARKER = /^\[review:\d+\]$/
const ISSUE_NUMBER = /^[1-9]\d*$/
export const DISPOSITION_EVENT = 'disposition'
export const MERGE_FOLLOW_UP = 'merge-follow-up'
export const DISPOSITION_DECIDERS = ['owner', 'window'] as const

interface Digest {
  path: string
  sha256: string
}

interface Verdict {
  task: string
  verdict: string
  head: string
  tree?: string
  brief: Digest
  report: Digest
}

export interface ReviewTarget {
  commit: string
  repo: string
  main?: string
}

const DEFAULT_MAIN = 'origin/main'
export const REVIEW_CARRY_EVENT = 'review-carry'

interface ResolvedCommit {
  commit: string
  tree: string
}

export type VerdictCheck
  = | { ok: true, line: Record<string, unknown> }
    | { ok: false, reasons: string[] }

function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readVerdict(verdictPath: string): Verdict | string {
  if (!existsSync(verdictPath))
    return `${verdictPath} does not exist`
  try {
    return JSON.parse(readFileSync(verdictPath, 'utf8')) as Verdict
  }
  catch (error) {
    return `${verdictPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`
  }
}

function reportReasons(report: Digest, dir: string): string[] {
  const reportFile = path.resolve(dir, report.path)
  if (!existsSync(reportFile))
    return [`report.path ${report.path} does not exist`]
  const actual = sha256OfBytes(readFileSync(reportFile))
  return actual === report.sha256 ? [] : [`report.sha256 ${report.sha256} is not the sha256 of ${report.path} (${actual})`]
}

function taskReasons(verdict: Verdict, dir: string): string[] {
  const reportFile = path.resolve(dir, verdict.report.path)
  if (!existsSync(reportFile))
    return []
  const firstLine = readFileSync(reportFile, 'utf8').split('\n', 1)[0]
  const expected = `[review:${verdict.task}]`
  if (firstLine === expected)
    return []
  const mismatch = `task ${verdict.task}: ${verdict.report.path} starts with ${JSON.stringify(firstLine)}, not ${expected}`
  return [namesCardNumber(firstLine, verdict.task) ? `${mismatch}; the marker names a card number; the review marker takes the task id ${verdict.task} from the tasks file` : mismatch]
}

function namesCardNumber(firstLine: string, task: string): boolean {
  return CARD_NUMBER_MARKER.test(firstLine) && !/^\d+$/.test(task)
}

function briefReasons(brief: Digest, dir: string): string[] {
  const approvalFile = approvedHashPath(path.resolve(dir, brief.path))
  const name = path.basename(approvalFile)
  if (!existsSync(approvalFile))
    return [`brief.path ${brief.path} has no approval file ${name} next to it`]
  const approved = extractApprovedHash(readFileSync(approvalFile, 'utf8'))
  if (approved === undefined)
    return [`no approval hash in ${name}`]
  return approved === brief.sha256 ? [] : [`brief.sha256 ${brief.sha256} is not the approved hash in ${name} (${approved})`]
}

function revParse(repo: string, revision: string): string {
  return execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--end-of-options', revision], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function resolveCommit(target: ReviewTarget): ResolvedCommit | undefined {
  try {
    return { commit: revParse(target.repo, `${target.commit}^{commit}`), tree: revParse(target.repo, `${target.commit}^{tree}`) }
  }
  catch {
    return undefined
  }
}

function treeReasons(tree: string, target: ReviewTarget, resolved: ResolvedCommit | undefined): string[] {
  if (resolved === undefined)
    return [`commit ${target.commit} is not a commit in ${target.repo}`]
  return resolved.tree === tree ? [] : [`verdict tree ${tree} is not the tree of ${target.commit} (${resolved.tree})`]
}

function reviewedCommit(dir: string, task: string, tree: string, file: Digest): string | undefined {
  const journal = path.join(dir, JOURNAL_FILE)
  if (!existsSync(journal))
    return undefined
  const commits = readFileSync(journal, 'utf8').split('\n').flatMap((text) => {
    try {
      const line = JSON.parse(text) as { event?: unknown, task?: unknown, tree?: unknown, commit?: unknown, file?: { sha256?: unknown } }
      return line.event === 'review' && line.task === task && line.tree === tree && line.file?.sha256 === file.sha256 && typeof line.commit === 'string' ? [line.commit] : []
    }
    catch {
      return []
    }
  })
  return commits.at(-1)
}

export type FetchedVerdict
  = | { ok: true, verdictPath: string }
    | { ok: false, reasons: string[] }

function showFromRef(repo: string, ref: string, file: string): Buffer {
  return execFileSync('git', ['-C', repo, 'show', `${ref}:${file}`], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

function reportPathFault(ref: string, verdictInRef: string, reportPath: string): string | undefined {
  if (reportPath === '' || reportPath === '.')
    return `--from ${ref}: the report path "${reportPath}" names no file; nothing written`
  if (reportPath.split(/[\\/]/).includes('..'))
    return `--from ${ref}: the report path ${reportPath} leaves the verdict's directory; nothing written`
  if (/[\\/]/.test(reportPath))
    return `--from ${ref}: the report path ${reportPath} has a directory part; the report lies beside the verdict file; nothing written`
  if (path.posix.basename(reportPath).toLowerCase() === path.posix.basename(verdictInRef).toLowerCase())
    return `--from ${ref}: the report ${reportPath} has the verdict file's name; nothing written`
  if (reportPath.toLowerCase() === JOURNAL_FILE)
    return `--from ${ref}: the report ${reportPath} has the journal's name; nothing written`
  return undefined
}

function occupiedTarget(target: string, bytes: Buffer): string | undefined {
  const entry = lstatSync(target, { throwIfNoEntry: false })
  if (entry === undefined)
    return undefined
  if (!entry.isFile())
    return `${target} is not a regular file`
  return readFileSync(target).equals(bytes) ? undefined : `${target} already holds other bytes`
}

export function fetchVerdictFromRef(ref: string, repo: string, verdictInRef: string, dir: string): FetchedVerdict {
  if (ref === '' || ref.startsWith('-'))
    return { ok: false, reasons: [`--from ${ref}: a ref is a name that does not start with "-"; nothing written`] }
  const refDir = path.posix.dirname(verdictInRef)
  try {
    const verdictBytes = showFromRef(repo, ref, verdictInRef)
    const reportPath: unknown = (JSON.parse(verdictBytes.toString('utf8')) as { report?: { path?: unknown } } | null)?.report?.path
    if (typeof reportPath !== 'string')
      return { ok: false, reasons: [`--from ${ref}: the verdict's report.path is not a string; nothing written`] }
    const fault = reportPathFault(ref, verdictInRef, reportPath)
    if (fault !== undefined)
      return { ok: false, reasons: [fault] }
    const reportBytes = showFromRef(repo, ref, path.posix.join(refDir, reportPath))
    const verdictPath = path.join(dir, path.posix.basename(verdictInRef))
    const reportTarget = path.join(dir, path.posix.basename(reportPath))
    const taken = [[verdictPath, verdictBytes], [reportTarget, reportBytes]] as const
    const occupied = taken.map(([target, bytes]) => occupiedTarget(target, bytes)).filter(reason => reason !== undefined)
    if (occupied.length > 0)
      return { ok: false, reasons: occupied.map(reason => `--from ${ref}: ${reason}; nothing written`) }
    mkdirSync(dir, { recursive: true })
    for (const [target, bytes] of taken)
      writeFileSync(target, bytes)
    return { ok: true, verdictPath }
  }
  catch (error) {
    return { ok: false, reasons: [`--from ${ref}: cannot read ${verdictInRef} and the report it names: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`] }
  }
}

function gitIn(repo: string): (args: string[]) => string {
  return args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function carriedLine(verdict: Verdict, tree: string, verdictPath: string, dir: string, target: ReviewTarget, resolved: ResolvedCommit, now: Date): VerdictCheck | undefined {
  const file = { path: path.relative(dir, verdictPath), sha256: sha256OfBytes(readFileSync(verdictPath)) }
  const from = reviewedCommit(dir, verdict.task, tree, file)
  if (from === undefined)
    return undefined
  const carry = reviewCarry(gitIn(target.repo), from, resolved.commit, target.main ?? DEFAULT_MAIN)
  if (!carry.ok)
    return { ok: false, reasons: [...treeReasons(tree, target, resolved), carry.reason] }
  return { ok: true, line: { event: REVIEW_CARRY_EVENT, ts: now.toISOString(), task: verdict.task, verdict: verdict.verdict, from, to: resolved.commit, tree, ownCommits: carry.ownCommits, merges: carry.merges, file } }
}

export function checkVerdict(verdictPath: string, dir: string, target: ReviewTarget, now: Date = new Date()): VerdictCheck {
  const verdict = readVerdict(verdictPath)
  if (typeof verdict === 'string')
    return { ok: false, reasons: [verdict] }
  if (verdict == null || typeof verdict !== 'object' || verdict.tree === undefined)
    return { ok: false, reasons: [`${verdictPath}: verdict has no tree`] }
  const schema = readContourSchema(VERDICT_SCHEMA)
  const faults = violations(verdict, schema).map(fault => `${verdictPath}: ${fault}`)
  if (faults.length > 0)
    return { ok: false, reasons: faults }
  const resolved = resolveCommit(target)
  const fileReasons = [...reportReasons(verdict.report, dir), ...taskReasons(verdict, dir), ...briefReasons(verdict.brief, dir)]
  const trees = treeReasons(verdict.tree, target, resolved)
  if (trees.length > 0 && resolved !== undefined && fileReasons.length === 0) {
    const carried = carriedLine(verdict, verdict.tree, verdictPath, dir, target, resolved, now)
    if (carried !== undefined)
      return carried
  }
  const reasons = [...trees, ...fileReasons]
  if (reasons.length > 0 || resolved === undefined)
    return { ok: false, reasons }
  const line = {
    event: 'review',
    ts: now.toISOString(),
    task: verdict.task,
    verdict: verdict.verdict,
    head: verdict.head,
    tree: verdict.tree,
    commit: resolved.commit,
    brief: verdict.brief,
    report: verdict.report,
    file: { path: path.relative(dir, verdictPath), sha256: sha256OfBytes(readFileSync(verdictPath)) },
  }
  const lineFaults = violations(line, { $ref: JOURNAL_LINE }, '', schema)
  return lineFaults.length > 0 ? { ok: false, reasons: lineFaults } : { ok: true, line }
}

export async function recordVerdict(verdictPath: string, dir: string, target: ReviewTarget): Promise<VerdictCheck> {
  const checked = checkVerdict(verdictPath, dir, target)
  if (checked.ok)
    await appendJournalEvent(path.join(dir, JOURNAL_FILE), checked.line)
  return checked
}

export interface DispositionInput {
  task: string | undefined
  pr: string | undefined
  followUp: string | undefined
  by: string | undefined
}

export type DispositionCheck
  = | { ok: true, line: { event: typeof DISPOSITION_EVENT, ts: string, task: string, decision: typeof MERGE_FOLLOW_UP, pr: number, followUp: number, by: string } }
    | { ok: false, reasons: string[] }

function numberReasons(flag: string, value: string | undefined): string[] {
  return value !== undefined && ISSUE_NUMBER.test(value) ? [] : [`--${flag} ${value ?? '(missing)'} is not a positive number`]
}

export function checkDisposition(input: DispositionInput, now: Date = new Date()): DispositionCheck {
  const reasons = [
    ...(input.task === undefined || input.task === '' ? ['--task is missing'] : []),
    ...numberReasons('pr', input.pr),
    ...numberReasons('follow-up', input.followUp),
    ...((DISPOSITION_DECIDERS as readonly (string | undefined)[]).includes(input.by) ? [] : [`--by ${input.by ?? '(missing)'} is not one of ${DISPOSITION_DECIDERS.join(', ')}`]),
  ]
  if (reasons.length > 0 || input.task === undefined || input.by === undefined)
    return { ok: false, reasons }
  return { ok: true, line: { event: DISPOSITION_EVENT, ts: now.toISOString(), task: input.task, decision: MERGE_FOLLOW_UP, pr: Number(input.pr), followUp: Number(input.followUp), by: input.by } }
}

export async function recordDisposition(input: DispositionInput, dir: string, now: Date = new Date()): Promise<DispositionCheck> {
  const checked = checkDisposition(input, now)
  if (checked.ok)
    await appendJournalEvent(path.join(dir, JOURNAL_FILE), checked.line)
  return checked
}

function report(checked: VerdictCheck | DispositionCheck): void {
  if (checked.ok) {
    console.log(JSON.stringify(checked.line))
    return
  }
  for (const reason of checked.reasons)
    console.error(reason)
  process.exitCode = 1
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { 'dir': { type: 'string' }, 'commit': { type: 'string' }, 'repo': { type: 'string' }, 'merge-follow-up': { type: 'string' }, 'task': { type: 'string' }, 'pr': { type: 'string' }, 'by': { type: 'string' }, 'from': { type: 'string' } } })
  if (values['merge-follow-up'] !== undefined) {
    const dir = values.dir ?? process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
    report(await recordDisposition({ task: values.task, pr: values.pr, followUp: values['merge-follow-up'], by: values.by }, dir))
    return
  }
  const verdictPath = positionals[0]
  const commit = values.commit
  if (verdictPath === undefined || commit === undefined) {
    console.error('usage: verdict.ts <review-<task>.verdict.json> --commit <PR head> [--repo <repository>] [--dir <handoff directory>] [--from <git ref>]')
    console.error('       verdict.ts --merge-follow-up <issue> --task <id> --pr <merged PR> --by <owner|window> [--dir <handoff directory>]')
    process.exitCode = 1
    return
  }
  const repo = values.repo ?? process.cwd()
  if (values.from === undefined) {
    report(await recordVerdict(verdictPath, values.dir ?? path.dirname(verdictPath), { commit, repo }))
    return
  }
  const dir = values.dir ?? process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
  const fetched = fetchVerdictFromRef(values.from, repo, verdictPath, dir)
  report(fetched.ok ? await recordVerdict(fetched.verdictPath, dir, { commit, repo }) : fetched)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
