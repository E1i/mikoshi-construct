import type { PrList, PullRequest } from '../board/gh.js'
import type { TasksFile } from './tasks.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { LEDGER_FILE } from '../../src/commands/cost/ledger.js'
import { STEP_CACHE_FILE } from '../../src/commands/cost/step-cache.js'
import { execGh, listPrs } from '../board/gh.js'
import { execGit } from '../board/git.js'
import { readHandoff } from '../board/handoff.js'
import { handLadderPolicy, handLadderRows } from '../board/policy.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { readUnregistered } from '../board/tree.js'
import { appendJournalEvent } from './journal.js'
import { carryLedgerLines, carryStepCacheLines } from './ledger.js'
import { freeRow, ghostRowState, writeGhostRow } from './status.js'
import { approvedSketchOf, lastRunSketch, patchPath, releaseTree, shortSketch, sketchSuperseded } from './supersede.js'
import { readTasksFile, startedTree } from './tasks.js'
import { DISPOSITION_EVENT, MERGE_FOLLOW_UP } from './verdict.js'

const PREFIX = '[ghosts:cleanup] '
const DEFAULT_LOGS_DIR = '/tmp'
const BLOCKED_OUTCOME = /; ladder blocked; report \S+;/
const DONE_OUTCOME = /^exit 0; ladder done; report \S+;/
const OUTCOME_COLUMN = 6
const SHA_COLUMN = 4
const START_COLUMN = 5
const BUSY_STATES = new Set(['writing', 'reviewing'])
const SUPERVISOR_NAMED = /, supervisor (\d+), /

export interface Target {
  id: string
  ghost?: string
  worktree: string
  branch: string
  pr?: number
  brief?: string
}

export interface CleanupContext {
  repo: string
  prs: PrList
  statusPath: string
  statusText: string | undefined
  journalPath: string
  logsDir: string
  ledger: string
  stepCache: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}

interface Disposition {
  pr: number
  followUp: number
}

interface ReviewStanding {
  verdict?: string
  disposition?: Disposition
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function label(task: Target): string {
  return `ghost-${task.ghost ?? task.id}`
}

function namesTask(task: Target, value: unknown): boolean {
  return value === task.id || (task.ghost !== undefined && value === task.ghost)
}

function reviewStanding(journalPath: string, task: Target): ReviewStanding {
  const standing: ReviewStanding = {}
  if (!existsSync(journalPath))
    return standing
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    try {
      const parsed = JSON.parse(line) as { event?: unknown, task?: unknown, verdict?: unknown, decision?: unknown, pr?: unknown, followUp?: unknown }
      if (!namesTask(task, parsed.task))
        continue
      if (parsed.event === 'review' && typeof parsed.verdict === 'string') {
        standing.verdict = parsed.verdict
        standing.disposition = undefined
      }
      if (parsed.event === DISPOSITION_EVENT && parsed.decision === MERGE_FOLLOW_UP && isNumber(parsed.pr) && isNumber(parsed.followUp))
        standing.disposition = { pr: parsed.pr, followUp: parsed.followUp }
    }
    catch {}
  }
  return standing
}

function changesRefusal(task: Target, disposition: Disposition, pr: PullRequest | undefined): string | undefined {
  if (pr?.number === disposition.pr && pr.state === 'MERGED')
    return undefined
  return `the last review verdict is changes, and its disposition merge + follow-up #${disposition.followUp} lifts it only once PR #${disposition.pr} of ${task.branch} is merged`
}

function changedPaths(worktree: string): number {
  return execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n')
    .filter(line => line !== '')
    .length
}

export function qualityLogs(logsDir: string, worktree: string): string[] {
  if (!existsSync(logsDir))
    return []
  const pattern = new RegExp(`^${escapeRegExp(path.basename(worktree))}[.-]quality.*\\.log$`)
  return readdirSync(logsDir).filter(name => pattern.test(name)).map(name => path.join(logsDir, name))
}

function kept(task: Target, reason: string): string {
  return `${label(task)} kept: ${reason}`
}

function treeLedger(task: Target): string {
  return path.join(task.worktree, LEDGER_FILE)
}

function treeStepCache(task: Target): string {
  return path.join(task.worktree, STEP_CACHE_FILE)
}

function carriedSteps(task: Target, stepCache: string): string {
  if (!existsSync(treeStepCache(task)))
    return ''
  return `; ${carryStepCacheLines(treeStepCache(task), stepCache)} step cache lines carried into ${stepCache}`
}

export function carryLedgerOnly(task: Target, ledger: string, stepCache: string): string {
  if (!existsSync(task.worktree))
    return `${label(task)} ledger: no worktree at ${task.worktree}`
  let carried: string
  try {
    carried = `${carryLedgerLines(treeLedger(task), ledger)} lines carried into ${ledger}`
  }
  catch (error) {
    return `${label(task)} ledger: lines could not be carried into ${ledger}: ${firstLine(error)}; worktree kept`
  }
  try {
    return `${label(task)} ledger: ${carried}${carriedSteps(task, stepCache)}; worktree kept`
  }
  catch (error) {
    return `${label(task)} ledger: ${carried}; step cache lines could not be carried into ${stepCache}: ${firstLine(error)}; worktree kept`
  }
}

function carryTreeLines(task: Target, ctx: CleanupContext): { carried: string } | { failure: string } {
  let carried: string
  try {
    carried = `; ${carryLedgerLines(treeLedger(task), ctx.ledger)} ledger lines carried into ${ctx.ledger}`
  }
  catch (error) {
    return { failure: `its ledger lines could not be carried into ${ctx.ledger}: ${firstLine(error)}` }
  }
  try {
    return { carried: carried + carriedSteps(task, ctx.stepCache) }
  }
  catch (error) {
    return { failure: `its step cache lines could not be carried into ${ctx.stepCache}: ${firstLine(error)}` }
  }
}

function freeOutcome(statusText: string | undefined, id: string): string | undefined {
  if (statusText === undefined || ghostRowState(statusText, id) !== 'free')
    return undefined
  const row = statusText.split('\n').find(line => line.startsWith(`| ghost-${id} |`))
  return row?.split('|')[OUTCOME_COLUMN]?.trim()
}

function unblockedRun(task: Target, outcome: string | undefined): string {
  const noPr = `no pull request for ${task.branch}`
  return kept(task, outcome === undefined ? noPr : `${noPr}, and status.md says "${outcome}", not ladder blocked`)
}

function keptNoPr(task: Target, outcome: string | undefined): string {
  return BLOCKED_OUTCOME.test(outcome ?? '') ? kept(task, 'ladder blocked; the task\'s tree stays for the next attempt') : unblockedRun(task, outcome)
}

function ladderEnded(outcome: string | undefined): boolean {
  return DONE_OUTCOME.test(outcome ?? '') || BLOCKED_OUTCOME.test(outcome ?? '')
}

async function releaseSuperseded(task: Target, ctx: CleanupContext): Promise<string | undefined> {
  const approved = approvedSketchOf(task.brief)
  const run = approved === undefined || !existsSync(ctx.journalPath) ? undefined : lastRunSketch(readFileSync(ctx.journalPath, 'utf8'), value => namesTask(task, value))
  if (approved === undefined || run === undefined || !sketchSuperseded(run.sketch, approved) || !existsSync(task.worktree))
    return undefined
  const patch = patchPath(path.dirname(ctx.journalPath), task.ghost ?? task.id, run.sketch)
  const result = releaseTree(task.worktree, patch)
  if ('clean' in result)
    return undefined
  if ('failure' in result)
    return kept(task, result.failure)
  await appendJournalEvent(ctx.journalPath, { event: 'superseded', task: run.task, by: approved, ts: new Date().toISOString() })
  return `${label(task)} released: superseded by sketch ${shortSketch(approved)}; work saved to ${patch}; tree ${task.worktree} clean for the next attempt`
}

interface BusyRow {
  state: string
  supervisor: number
  sha: string
  start: string
}

function busyRow(statusText: string | undefined, id: string): BusyRow | undefined {
  if (statusText === undefined)
    return undefined
  const state = ghostRowState(statusText, id)
  if (state === undefined || !BUSY_STATES.has(state))
    return undefined
  const cells = statusText.split('\n').find(line => line.startsWith(`| ghost-${id} |`))!.split('|').map(cell => cell.trim())
  const named = SUPERVISOR_NAMED.exec(cells[OUTCOME_COLUMN] ?? '')
  return named === null ? undefined : { state, supervisor: Number(named[1]), sha: cells[SHA_COLUMN]!, start: cells[START_COLUMN]! }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function minuteStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function stashKilledTree(worktree: string, message: string): string {
  if (changedPaths(worktree) === 0)
    return 'clean'
  execFileSync('git', ['-C', worktree, 'stash', 'push', '--include-untracked', '-m', message], { stdio: 'pipe' })
  const entry = execFileSync('git', ['-C', worktree, 'stash', 'list', '--format=%H %gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n')
    .find(line => line.endsWith(`: ${message}`))
  return `clean, its changes stashed as ${entry?.slice(0, 7) ?? 'an entry'} "${message}"`
}

function setReportAside(report: string, aside: string): string {
  if (!existsSync(report))
    return `no report at ${report}`
  if (existsSync(aside))
    throw new Error(`${aside} already exists`)
  renameSync(report, aside)
  return `report moved to ${aside}`
}

export async function releaseKilled(task: Target, ctx: CleanupContext): Promise<string | undefined> {
  const id = task.ghost ?? task.id
  const row = busyRow(ctx.statusText, id)
  if (row === undefined)
    return undefined
  if (processAlive(row.supervisor))
    return kept(task, `status.md row ghost-${id} is ${row.state} and its supervisor ${row.supervisor} is alive`)
  const out = path.dirname(ctx.journalPath)
  const killed = `supervisor ${row.supervisor} dead`
  let tree: string
  let report: string
  try {
    tree = existsSync(task.worktree) ? `tree ${task.worktree} ${stashKilledTree(task.worktree, `ghosts:cleanup ghost-${id} ${killed}`)}` : `no tree at ${task.worktree}`
    report = setReportAside(path.join(out, `ghost-${id}.jsonl`), path.join(out, `ghost-${id}.killed-${row.supervisor}.jsonl`))
  }
  catch (error) {
    return kept(task, `${killed} with the row ${row.state}, but the run could not be set aside: ${firstLine(error)}`)
  }
  const headSha = existsSync(task.worktree) ? execFileSync('git', ['-C', task.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() : row.sha
  await writeGhostRow(ctx.statusPath, id, freeRow({ id, worktree: task.worktree, headSha, start: row.start, end: minuteStamp(new Date()), outcome: `${killed}; freed by ghosts:cleanup` }))
  return `${label(task)} released: ${killed} with the row ${row.state}; row ghost-${id} free; ${report}; ${tree}`
}

export async function cleanupMerged(task: Target, ctx: CleanupContext): Promise<string> {
  const handLadder = [task.ghost, task.id].find(id => id !== undefined && handLadderRows(ctx.statusText).has(id))
  if (handLadder !== undefined)
    return kept(task, `status.md policy ${handLadderPolicy(handLadder)}; a hand-ladder worktree is never removed`)
  const standing = reviewStanding(ctx.journalPath, task)
  const overruled = standing.verdict === 'changes' ? standing.disposition : undefined
  if (standing.verdict === 'changes' && overruled === undefined)
    return kept(task, 'the last review verdict is changes')
  if (ctx.prs.kind === 'failed')
    return kept(task, 'gh unavailable; the pull request state is unknown')
  const pr = ctx.prs.prs.find(candidate => task.pr === undefined ? candidate.headRefName === task.branch : candidate.number === task.pr)
  const refusal = overruled === undefined ? undefined : changesRefusal(task, overruled, pr)
  if (refusal !== undefined)
    return kept(task, refusal)
  if (pr === undefined) {
    const outcome = freeOutcome(ctx.statusText, task.ghost ?? task.id)
    const released = ladderEnded(outcome) ? await releaseSuperseded(task, ctx) : undefined
    return released ?? keptNoPr(task, outcome)
  }
  if (pr.state !== 'MERGED')
    return kept(task, `PR #${pr.number} is ${pr.state}, not merged`)

  const removed: string[] = []
  let carried = ''
  if (existsSync(task.worktree)) {
    let dirty: number
    try {
      dirty = changedPaths(task.worktree)
    }
    catch (error) {
      return kept(task, `PR #${pr.number} merged, but git status failed in ${task.worktree}: ${firstLine(error)}`)
    }
    if (dirty > 0)
      return kept(task, `PR #${pr.number} merged, but ${task.worktree} is dirty (${dirty} changed paths)`)
    const lines = carryTreeLines(task, ctx)
    if ('failure' in lines)
      return kept(task, `PR #${pr.number} merged, but ${lines.failure}`)
    carried = lines.carried
    execFileSync('git', ['-C', ctx.repo, 'worktree', 'remove', task.worktree], { stdio: 'pipe' })
    removed.push(`worktree ${task.worktree}`)
  }

  const logs = qualityLogs(ctx.logsDir, task.worktree)
  for (const log of logs)
    rmSync(log)
  removed.push(`${logs.length} quality logs`)
  const overrule = overruled === undefined ? '' : ` over a changes verdict, follow-up #${overruled.followUp}`
  return `${label(task)} removed: PR #${pr.number} merged${overrule}${carried}; ${removed.join(' and ')}`
}

function defaultRepo(cwd: string): string | undefined {
  try {
    const parsed = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { nameWithOwner?: unknown }
    return typeof parsed.nameWithOwner === 'string' ? parsed.nameWithOwner : undefined
  }
  catch {
    return undefined
  }
}

function toplevel(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function mainCheckout(repoRoot: string): string {
  const commonDir = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return path.dirname(commonDir)
}

function handoffTargets(handoffDir: string, repoRoot: string): { targets: Target[], untracked: string[] } {
  const { attempts } = readHandoff(handoffDir)
  const targets = attempts.flatMap(attempt => attempt.worktree === undefined || attempt.branch === undefined
    ? []
    : [{ id: attempt.id, ghost: attempt.ghost, worktree: attempt.worktree, branch: attempt.branch, pr: attempt.pathEvent?.pr, brief: attempt.brief }])
  const untracked = readUnregistered(repoRoot, attempts, execGit).map(tree => `unregistered ${tree.worktree} kept: named by no task`)
  return { targets, untracked }
}

function tasksTargets(tasksData: TasksFile): { targets: Target[], untracked: string[] } {
  const journalPath = path.join(tasksData.out, 'ghosts.jsonl')
  const journalText = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : ''
  const targets: Target[] = []
  const untracked: string[] = []
  for (const task of tasksData.tasks) {
    const tree = startedTree(journalText, task.card)
    if (tree === undefined)
      untracked.push(`ghost-${task.id} kept: card #${task.card.id} has no task:start line in ${journalPath}`)
    else
      targets.push({ id: String(task.card.id), ghost: task.id, brief: task.brief, ...tree })
  }
  return { targets, untracked }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { 'tasks': { type: 'string' }, 'repo': { type: 'string' }, 'logs': { type: 'string' }, 'ledger-only': { type: 'boolean' } } })
  const handoffDir = process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
  const tasksData = values.tasks === undefined ? undefined : readTasksFile(values.tasks)
  const repoRoot = tasksData?.repo ?? toplevel()
  const checkout = mainCheckout(repoRoot)
  const ledger = path.join(checkout, LEDGER_FILE)
  const stepCache = path.join(checkout, STEP_CACHE_FILE)
  const { targets, untracked } = tasksData === undefined ? handoffTargets(handoffDir, repoRoot) : tasksTargets(tasksData)
  if (values['ledger-only'] === true) {
    for (const task of targets)
      console.log(`${PREFIX}${carryLedgerOnly(task, ledger, stepCache)}`)
    return
  }
  const repo = values.repo ?? defaultRepo(repoRoot)
  const statusPath = tasksData?.status ?? path.join(handoffDir, 'status.md')
  const ctx: CleanupContext = {
    repo: repoRoot,
    prs: repo === undefined ? { kind: 'failed' } : listPrs(execGh, repo),
    statusPath,
    statusText: existsSync(statusPath) ? readFileSync(statusPath, 'utf8') : undefined,
    journalPath: path.join(tasksData?.out ?? handoffDir, 'ghosts.jsonl'),
    logsDir: values.logs ?? DEFAULT_LOGS_DIR,
    ledger,
    stepCache,
  }
  for (const task of targets)
    console.log(`${PREFIX}${await releaseKilled(task, ctx) ?? await cleanupMerged(task, ctx)}`)
  for (const line of untracked)
    console.log(`${PREFIX}${line}`)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  }
  catch (error) {
    console.error(`${PREFIX}${firstLine(error)}`)
    process.exitCode = 1
  }
}
