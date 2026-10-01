import type { PrList } from '../board/gh.js'
import type { Task } from './tasks.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { lookupPr } from '../board/gh.js'
import { handLadderRows } from '../board/policy.js'

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

export function cleanupMerged(task: Task, ctx: CleanupContext): string | undefined {
  if (handLadderRows(ctx.statusText).has(task.id))
    return undefined
  if (lastVerdict(ctx.journalPath, task.id) === 'changes')
    return undefined
  const lookup = lookupPr(ctx.prs, task.branch)
  if (lookup.kind !== 'found' || lookup.pr.state !== 'MERGED')
    return undefined

  const merged = `PR #${lookup.pr.number} merged`
  let removedWorktree = false
  if (existsSync(task.worktree)) {
    let dirty: number
    try {
      dirty = changedPaths(task.worktree)
    }
    catch (error) {
      return `ghost-${task.id} cleanup: ${merged}; kept ${task.worktree}: git status failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    }
    if (dirty > 0)
      return `ghost-${task.id} cleanup: ${merged}; kept ${task.worktree}: the worktree is dirty (${dirty} changed paths)`
    execFileSync('git', ['-C', ctx.repo, 'worktree', 'remove', task.worktree], { stdio: 'pipe' })
    removedWorktree = true
  }

  const logs = qualityLogs(ctx.logsDir, task.worktree)
  for (const log of logs)
    rmSync(log)
  if (!removedWorktree && logs.length === 0)
    return undefined
  const removed = [removedWorktree ? `worktree ${task.worktree}` : undefined, logs.length > 0 ? `${logs.length} quality logs` : undefined].filter(Boolean).join(' and ')
  return `ghost-${task.id} cleanup: ${merged}; removed ${removed}`
}
