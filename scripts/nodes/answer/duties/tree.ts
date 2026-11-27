import type { CarriedTree } from '../../../core/lease.js'
import type { UnselectedWitness } from '../../../ports/witnesses.js'
import type { CardSession } from '../answer-source.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { processGit, throughGitPort } from '../../../ports/git.js'
import { MAIN_BRANCH } from '../../../ports/snapshot.js'
import { unselectedWitnessesLine, unselectedWitnessesOf } from '../../../ports/witnesses.js'

export type TreeMerge = { kind: 'none' } | { kind: 'mid-merge', files: string[] } | { kind: 'unreadable', why: string }

interface PendingPath {
  file: string
  untracked: boolean
}

const UNTRACKED = '??'
const TREE_GIT_MAX_BUFFER = 64 * 1024 * 1024

export const git = throughGitPort((cwd, args) => processGit.readBytes(cwd, args, TREE_GIT_MAX_BUFFER).toString('utf8'))

function pushes(card: CardSession): boolean {
  try {
    git(card.worktree, ['push', 'origin', `HEAD:refs/heads/${card.branch}`])
    return true
  }
  catch {
    return false
  }
}

function headFileOf(worktree: string, file: string): string | null {
  try {
    return git(worktree, ['show', `HEAD:${file}`])
  }
  catch {
    return null
  }
}

export function unselectedAtHead(worktree: string, cardBody: string | null): UnselectedWitness[] {
  return cardBody === null ? [] : unselectedWitnessesOf(cardBody, file => headFileOf(worktree, file))
}

function treeFileOf(worktree: string, file: string): string | null {
  try {
    return readFileSync(path.join(worktree, file), 'utf8')
  }
  catch {
    return null
  }
}

export function unselectedInTree(worktree: string, cardBody: string | null): UnselectedWitness[] {
  return cardBody === null ? [] : unselectedWitnessesOf(cardBody, file => treeFileOf(worktree, file))
}

export class WitnessUnselected extends Error {
  constructor(readonly unselected: readonly UnselectedWitness[]) {
    super(`the bus pushed nothing: ${unselectedWitnessesLine(unselected)}; write each witness test under the card's witness file and its title verbatim`)
  }
}

export function refuseUnselectedInTree(worktree: string, cardBody: string | null): void {
  const unselected = unselectedInTree(worktree, cardBody)
  if (unselected.length > 0)
    throw new WitnessUnselected(unselected)
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
    const line = processGit.read(card.worktree, ['ls-remote', 'origin', `refs/heads/${card.branch}`])
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

export type TreeOwned
  = | { kind: 'clean', head: string }
    | { kind: 'kept', head: string }
    | { kind: 'pushed', head: string, commits: string[] }
    | { kind: 'reset', head: string, dropped: string[], dirty: boolean }
    | { kind: 'unselected', head: string, unselected: UnselectedWitness[] }

function linesOf(output: string): string[] {
  return output.split('\n').map(line => line.trim()).filter(line => line !== '')
}

export function carriedTreeState(card: CardSession, prHead: string): CarriedTree | null {
  try {
    const head = git(card.worktree, ['rev-parse', 'HEAD']).trim()
    return { path: card.worktree, head, localCommits: linesOf(git(card.worktree, ['rev-list', 'HEAD', '--not', prHead, '--remotes'])), dirty: treeDirtyOf(card) }
  }
  catch {
    return null
  }
}

function ancestor(worktree: string, commit: string, of: string): boolean {
  return processGit.succeeds(worktree, ['merge-base', '--is-ancestor', commit, of])
}

function mergeOfMain(worktree: string, commit: string): boolean {
  const [, ...merged] = git(worktree, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ').slice(1)
  return merged.length > 0 && merged.every(parent => ancestor(worktree, parent, `origin/${MAIN_BRANCH}`))
}

function onlyMainMergedOver(state: CarriedTree, prHead: string): boolean {
  return !state.dirty && ancestor(state.path, prHead, 'HEAD') && state.localCommits.every(commit => mergeOfMain(state.path, commit))
}

export type TreePushPolicy = 'none' | 'bus'

export function ownCarriedTree(card: CardSession, prHead: string, policy: TreePushPolicy, cardBody: string | null = null): TreeOwned {
  const state = carriedTreeState(card, prHead)
  if (state === null)
    throw new Error(`the tree ${card.worktree} of the card cannot be read against the pull request head ${prHead}`)
  if (!state.dirty && state.head === prHead)
    return { kind: 'clean', head: prHead }
  if (policy === 'none')
    return { kind: 'kept', head: state.head }
  const mergedOnly = onlyMainMergedOver(state, prHead)
  const unselected = mergedOnly ? unselectedAtHead(card.worktree, cardBody) : []
  if (unselected.length > 0)
    return { kind: 'unselected', head: state.head, unselected }
  if (mergedOnly && pushes(card))
    return { kind: 'pushed', head: state.head, commits: state.localCommits }
  if (!processGit.succeeds(card.worktree, ['reset', '--hard', prHead]) || !processGit.succeeds(card.worktree, ['clean', '-fd']))
    throw new Error(`the tree ${card.worktree} of the card could not be reset to the pull request head ${prHead}`)
  return { kind: 'reset', head: prHead, dropped: state.localCommits, dirty: state.dirty }
}
