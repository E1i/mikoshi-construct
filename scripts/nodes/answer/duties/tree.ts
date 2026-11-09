import type { CardSession } from '../answer-source.js'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { MAIN_BRANCH } from '../../../ports/snapshot.js'

export type TreeMerge = { kind: 'none' } | { kind: 'mid-merge', files: string[] } | { kind: 'unreadable', why: string }

interface PendingPath {
  file: string
  untracked: boolean
}

const UNTRACKED = '??'

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

export function localHead(card: CardSession): string | null {
  try {
    return git(card.worktree, ['rev-parse', 'HEAD']).trim() || null
  }
  catch {
    return null
  }
}

export function remoteHead(card: CardSession): string | null {
  try {
    const line = execFileSync('git', ['-C', card.worktree, 'ls-remote', 'origin', `refs/heads/${card.branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return line.split(/\s/)[0] || null
  }
  catch {
    return null
  }
}

export function diffAgainstBase(card: CardSession): string | null {
  try {
    const base = git(card.worktree, ['merge-base', `origin/${MAIN_BRANCH}`, 'HEAD']).trim()
    return git(card.worktree, ['diff', base])
  }
  catch {
    return null
  }
}

export function treeMergeOf(card: CardSession): TreeMerge {
  try {
    const mergeHead = path.resolve(card.worktree, git(card.worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim())
    const unmerged = git(card.worktree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(file => file !== '')
    return existsSync(mergeHead) || unmerged.length > 0 ? { kind: 'mid-merge', files: unmerged } : { kind: 'none' }
  }
  catch (error) {
    return { kind: 'unreadable', why: error instanceof Error ? error.message.trim() : String(error) }
  }
}

function porcelainEntries(output: string): PendingPath[] {
  const entries = output.split('\0').filter(each => each !== '')
  const pending: PendingPath[] = []
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at]!
    pending.push({ file: entry.slice(3), untracked: entry.startsWith(UNTRACKED) })
    if (entry.startsWith('R') || entry.startsWith('C'))
      at += 1
  }
  return pending
}

function committedOnTheBranch(card: CardSession): string[] {
  const base = git(card.worktree, ['merge-base', `origin/${MAIN_BRANCH}`, 'HEAD']).trim()
  return git(card.worktree, ['diff', '--name-only', '-z', base, 'HEAD']).split('\0').filter(file => file !== '')
}

function uncommitted(card: CardSession): string[] {
  const changed = porcelainEntries(git(card.worktree, ['status', '--porcelain', '-z', '--untracked-files=all']))
  if (treeMergeOf(card).kind !== 'mid-merge')
    return changed.map(each => each.file)
  const differFromTheMergedBranch = new Set(git(card.worktree, ['diff', '--name-only', '-z', 'MERGE_HEAD']).split('\0'))
  return changed.filter(each => each.untracked || differFromTheMergedBranch.has(each.file)).map(each => each.file)
}

export function pendingPathsOf(card: CardSession): string[] {
  return [...new Set([...committedOnTheBranch(card), ...uncommitted(card)])]
}

export function treeDirtyOf(card: CardSession): boolean {
  try {
    return git(card.worktree, ['status', '--porcelain']).trim() !== ''
  }
  catch {
    return false
  }
}
