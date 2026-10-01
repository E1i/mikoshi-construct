import type { PrList } from '../board/gh.js'
import type { Task } from './tasks.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { execGh, listPrs } from '../board/gh.js'
import { handLadderPolicy, handLadderRows } from '../board/policy.js'
import { readTasksFile } from './tasks.js'

const PREFIX = '[ghosts:cleanup] '
const DEFAULT_LOGS_DIR = '/tmp'
const USAGE = 'usage: cleanup.ts --tasks <file> [--repo <owner>/<name>] [--logs <dir>]'

export interface CleanupContext {
  repo: string
  prs: PrList
  statusText: string | undefined
  journalPath: string
  logsDir: string
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

function kept(task: Task, reason: string): string {
  return `ghost-${task.id} kept: ${reason}`
}

export function cleanupMerged(task: Task, ctx: CleanupContext): string {
  if (handLadderRows(ctx.statusText).has(task.id))
    return kept(task, `status.md policy ${handLadderPolicy(task.id)}; a hand-ladder worktree is never removed`)
  if (lastVerdict(ctx.journalPath, task.id) === 'changes')
    return kept(task, 'the last review verdict is changes')
  if (ctx.prs.kind === 'failed')
    return kept(task, 'gh unavailable; the pull request state is unknown')
  const pr = ctx.prs.prs.find(candidate => candidate.headRefName === task.branch)
  if (pr === undefined)
    return kept(task, `no pull request for ${task.branch}`)
  if (pr.state !== 'MERGED')
    return kept(task, `PR #${pr.number} is ${pr.state}, not merged`)

  const removed: string[] = []
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
    execFileSync('git', ['-C', ctx.repo, 'worktree', 'remove', task.worktree], { stdio: 'pipe' })
    removed.push(`worktree ${task.worktree}`)
  }

  const logs = qualityLogs(ctx.logsDir, task.worktree)
  for (const log of logs)
    rmSync(log)
  removed.push(`${logs.length} quality logs`)
  return `ghost-${task.id} removed: PR #${pr.number} merged; ${removed.join(' and ')}`
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

function main(): void {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { tasks: { type: 'string' }, repo: { type: 'string' }, logs: { type: 'string' } } })
  if (values.tasks === undefined)
    throw new Error(`--tasks is required: ${USAGE}`)
  const tasksData = readTasksFile(values.tasks)
  const repo = values.repo ?? defaultRepo(tasksData.repo)
  const ctx: CleanupContext = {
    repo: tasksData.repo,
    prs: repo === undefined ? { kind: 'failed' } : listPrs(execGh, repo),
    statusText: existsSync(tasksData.status) ? readFileSync(tasksData.status, 'utf8') : undefined,
    journalPath: path.join(tasksData.out, 'ghosts.jsonl'),
    logsDir: values.logs ?? DEFAULT_LOGS_DIR,
  }
  for (const task of tasksData.tasks)
    console.log(`${PREFIX}${cleanupMerged(task, ctx)}`)
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
