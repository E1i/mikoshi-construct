import type { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { pathsOutsideTheBody } from '../core/card-bodies.js'
import { messageOf } from '../core/errors.js'
import { commandLine, isRebuiltOnUpdate, rebuildsOf, SHARED_APPEND_PATHS } from '../core/generated-files.js'
import { MAIN_BRANCH } from './snapshot.js'
import { gitIn } from './worktree.js'

const MAIN_REF = `origin/${MAIN_BRANCH}`

export interface ConflictingCard {
  cardId: number
  branch: string
  outsideTheCard: (files: string[]) => string[]
  head: string
}

export type MainMerge
  = | { kind: 'merged', to: string, tookMain: string[], rebuilt: string[] }
    | { kind: 'inside', files: string[] }
    | { kind: 'refused', why: string }

export type MergeMain = (card: ConflictingCard) => MainMerge

export type TreeGit = (cwd: string, args: string[]) => string

function unmergedIn(git: TreeGit, tree: string): string[] {
  return git(tree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(file => file !== '')
}

function onMain(git: TreeGit, tree: string, file: string): boolean {
  try {
    git(tree, ['cat-file', '-e', `${MAIN_REF}:${file}`])
    return true
  }
  catch {
    return false
  }
}

function takeMain(git: TreeGit, tree: string, file: string): void {
  if (onMain(git, tree, file))
    git(tree, ['checkout', MAIN_REF, '--', file])
  else
    git(tree, ['rm', '-q', '--', file])
}

function abortMerge(git: TreeGit, tree: string): void {
  try {
    git(tree, ['merge', '--abort'])
  }
  catch {}
}

export type RebuildRunner = (cwd: string, args: readonly string[]) => { status: number | null, stderr: string }

function pnpmRebuild(cwd: string, args: readonly string[]): { status: number | null, stderr: string } {
  const result = spawnSync('pnpm', [...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stderr: result.error?.message ?? result.stderr }
}

function rebuildGenerated(git: TreeGit, tree: string, card: ConflictingCard, files: readonly string[], run: RebuildRunner): MainMerge | null {
  for (const rebuild of rebuildsOf(files)) {
    const result = run(tree, rebuild)
    if (result.status !== 0) {
      git(tree, ['reset', '-q', '--hard', card.head])
      return { kind: 'refused', why: `the rebuild after the merge of ${MAIN_BRANCH} failed, and the tree went back to ${card.head}: ${commandLine(rebuild)} exited ${result.status ?? 'without a status'}: ${result.stderr.trim()}` }
    }
  }
  const changed = git(tree, ['ls-files', '-m', '-o', '--exclude-standard', '--', ...SHARED_APPEND_PATHS]).split('\n').filter(file => file !== '')
  if (changed.length > 0) {
    git(tree, ['add', '--', ...changed])
    git(tree, ['commit', '-q', '--amend', '--no-edit'])
  }
  return null
}

export function conflictingCardOf(db: DatabaseSync, cardId: number, branch: string, head: string): ConflictingCard {
  return { cardId, branch, outsideTheCard: files => pathsOutsideTheBody(db, cardId, files.join('\n')), head }
}

export type MergedMain = 'pushed' | 'kept-in-the-tree'

function mergeMainIn(git: TreeGit, tree: string, card: ConflictingCard, run: RebuildRunner, merged: MergedMain): MainMerge {
  const at = git(tree, ['rev-parse', 'HEAD'])
  if (at !== card.head)
    return { kind: 'refused', why: `the tree ${tree} stands at ${at}, not at the head ${card.head}` }
  if (git(tree, ['status', '--porcelain']) !== '')
    return { kind: 'refused', why: `the tree ${tree} has changes of its own` }
  git(tree, ['fetch', '-q', 'origin', MAIN_BRANCH])
  const carried = git(tree, ['diff', '--name-only', `${MAIN_REF}...HEAD`]).split('\n').filter(isRebuiltOnUpdate)
  let tookMain: string[] = []
  let conflicted: string[] = []
  try {
    git(tree, ['merge', '-q', '--no-edit', MAIN_REF])
  }
  catch (error) {
    const files = unmergedIn(git, tree)
    if (files.length === 0) {
      abortMerge(git, tree)
      return { kind: 'refused', why: messageOf(error) }
    }
    conflicted = files.filter(isRebuiltOnUpdate)
    const rest = files.filter(file => !isRebuiltOnUpdate(file))
    const outside = card.outsideTheCard(rest)
    const inside = rest.filter(file => !outside.includes(file))
    if (inside.length > 0) {
      abortMerge(git, tree)
      return { kind: 'inside', files: inside }
    }
    for (const file of files)
      takeMain(git, tree, file)
    git(tree, ['commit', '-q', '--no-edit'])
    tookMain = rest
  }
  const moved = git(tree, ['rev-parse', 'HEAD']) !== card.head
  const rebuilt = moved ? [...new Set([...conflicted, ...carried])] : []
  const refused = rebuildGenerated(git, tree, card, rebuilt, run)
  if (refused !== null)
    return refused
  return merged === 'pushed' ? pushedOrUndone(git, tree, card, tookMain, rebuilt) : { kind: 'merged', to: git(tree, ['rev-parse', 'HEAD']), tookMain, rebuilt }
}

function pushedOrUndone(git: TreeGit, tree: string, card: ConflictingCard, tookMain: string[], rebuilt: string[]): MainMerge {
  const to = git(tree, ['rev-parse', 'HEAD'])
  try {
    git(tree, ['push', '-q', 'origin', `HEAD:refs/heads/${card.branch}`])
  }
  catch (error) {
    git(tree, ['reset', '-q', '--hard', card.head])
    return { kind: 'refused', why: `the push of the merge ${to} to ${card.branch} failed, and the tree went back to ${card.head}: ${messageOf(error)}` }
  }
  return { kind: 'merged', to, tookMain, rebuilt }
}

export function mainMergeInCardTree(git: TreeGit, treeOf: (cardId: number) => string, run: RebuildRunner = pnpmRebuild, merged: MergedMain = 'pushed'): MergeMain {
  return (card) => {
    const tree = treeOf(card.cardId)
    try {
      return mergeMainIn(git, tree, card, run, merged)
    }
    catch (error) {
      abortMerge(git, tree)
      return { kind: 'refused', why: messageOf(error) }
    }
  }
}

export function mainKeptInTheTree(tree: string): MergeMain {
  return mainMergeInCardTree(gitIn, () => tree, pnpmRebuild, 'kept-in-the-tree')
}
