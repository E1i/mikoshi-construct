import type { PrList } from '../board/gh.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { LEDGER_FILE } from '../../src/commands/cost/ledger.js'
import { execGh, listPrs } from '../board/gh.js'
import { execGit } from '../board/git.js'
import { readHandoff } from '../board/handoff.js'
import { handLadderPolicy, handLadderRows } from '../board/policy.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { readUnregistered } from '../board/tree.js'
import { carryLedgerLines } from './ledger.js'
import { readTasksFile } from './tasks.js'

const PREFIX = '[ghosts:cleanup] '
const DEFAULT_LOGS_DIR = '/tmp'

export interface Target {
  id: string
  worktree: string
  branch: string
  pr?: number
}

export interface CleanupContext {
  repo: string
  prs: PrList
  statusText: string | undefined
  journalPath: string
  logsDir: string
  ledger: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}

function lastVerdict(journalPath: string, id: string): string | undefined {
  if (!existsSync(journalPath))
    return undefined
  let verdict: string | undefined
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    try {
      const parsed = JSON.parse(line) as { event?: unknown, task?: unknown, verdict?: unknown }
      if (parsed.event === 'review' && parsed.task === id && typeof parsed.verdict === 'string')
        verdict = parsed.verdict
    }
    catch {}
  }
  return verdict
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
  return `ghost-${task.id} kept: ${reason}`
}

function treeLedger(task: Target): string {
  return path.join(task.worktree, LEDGER_FILE)
}

export function carryLedgerOnly(task: Target, ledger: string): string {
  if (!existsSync(task.worktree))
    return `ghost-${task.id} ledger: no worktree at ${task.worktree}`
  try {
    return `ghost-${task.id} ledger: ${carryLedgerLines(treeLedger(task), ledger)} lines carried into ${ledger}; worktree kept`
  }
  catch (error) {
    return `ghost-${task.id} ledger: lines could not be carried into ${ledger}: ${firstLine(error)}; worktree kept`
  }
}

export function cleanupMerged(task: Target, ctx: CleanupContext): string {
  if (handLadderRows(ctx.statusText).has(task.id))
    return kept(task, `status.md policy ${handLadderPolicy(task.id)}; a hand-ladder worktree is never removed`)
  if (lastVerdict(ctx.journalPath, task.id) === 'changes')
    return kept(task, 'the last review verdict is changes')
  if (ctx.prs.kind === 'failed')
    return kept(task, 'gh unavailable; the pull request state is unknown')
  const pr = ctx.prs.prs.find(candidate => task.pr === undefined ? candidate.headRefName === task.branch : candidate.number === task.pr)
  if (pr === undefined)
    return kept(task, `no pull request for ${task.branch}`)
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
    try {
      carried = `; ${carryLedgerLines(treeLedger(task), ctx.ledger)} ledger lines carried into ${ctx.ledger}`
    }
    catch (error) {
      return kept(task, `PR #${pr.number} merged, but its ledger lines could not be carried into ${ctx.ledger}: ${firstLine(error)}`)
    }
    execFileSync('git', ['-C', ctx.repo, 'worktree', 'remove', task.worktree], { stdio: 'pipe' })
    removed.push(`worktree ${task.worktree}`)
  }

  const logs = qualityLogs(ctx.logsDir, task.worktree)
  for (const log of logs)
    rmSync(log)
  removed.push(`${logs.length} quality logs`)
  return `ghost-${task.id} removed: PR #${pr.number} merged${carried}; ${removed.join(' and ')}`
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

function mainLedger(repoRoot: string): string {
  const commonDir = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return path.join(path.dirname(commonDir), LEDGER_FILE)
}

function handoffTargets(handoffDir: string, repoRoot: string): { targets: Target[], unregistered: string[] } {
  const { attempts } = readHandoff(handoffDir)
  const targets = attempts.flatMap(attempt => attempt.worktree === undefined || attempt.branch === undefined
    ? []
    : [{ id: attempt.id, worktree: attempt.worktree, branch: attempt.branch, pr: attempt.pathEvent?.pr }])
  const unregistered = readUnregistered(repoRoot, attempts, execGit).map(tree => `unregistered ${tree.worktree} kept: named by no task`)
  return { targets, unregistered }
}

function main(): void {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { 'tasks': { type: 'string' }, 'repo': { type: 'string' }, 'logs': { type: 'string' }, 'ledger-only': { type: 'boolean' } } })
  const handoffDir = process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
  const tasksData = values.tasks === undefined ? undefined : readTasksFile(values.tasks)
  const repoRoot = tasksData?.repo ?? toplevel()
  const ledger = mainLedger(repoRoot)
  const { targets, unregistered } = tasksData === undefined ? handoffTargets(handoffDir, repoRoot) : { targets: tasksData.tasks, unregistered: [] }
  if (values['ledger-only'] === true) {
    for (const task of targets)
      console.log(`${PREFIX}${carryLedgerOnly(task, ledger)}`)
    return
  }
  const repo = values.repo ?? defaultRepo(repoRoot)
  const statusPath = tasksData?.status ?? path.join(handoffDir, 'status.md')
  const ctx: CleanupContext = {
    repo: repoRoot,
    prs: repo === undefined ? { kind: 'failed' } : listPrs(execGh, repo),
    statusText: existsSync(statusPath) ? readFileSync(statusPath, 'utf8') : undefined,
    journalPath: path.join(tasksData?.out ?? handoffDir, 'ghosts.jsonl'),
    logsDir: values.logs ?? DEFAULT_LOGS_DIR,
    ledger,
  }
  for (const task of targets)
    console.log(`${PREFIX}${cleanupMerged(task, ctx)}`)
  for (const line of unregistered)
    console.log(`${PREFIX}${line}`)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  }
  catch (error) {
    console.error(`${PREFIX}${firstLine(error)}`)
    process.exitCode = 1
  }
}
