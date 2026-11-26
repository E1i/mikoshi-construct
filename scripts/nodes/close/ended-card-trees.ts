import type { DatabaseSync } from 'node:sqlite'
import type { ProcessCwds } from '../../ports/client/contract.js'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { busDirOf } from '../../core/bus-path.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../../core/card-automaton.js'
import { cardStatesAmong } from '../../core/card-readings.js'
import { appendEvent } from '../../core/db.js'
import { ARTIFACT_REMOVED, BOARD_ALARM } from '../../core/events.js'
import { LEASED } from '../../core/queue.js'
import { ofCard as tasksOfCard } from '../../core/tasks-query.js'
import { portGit as git, processGit } from '../../ports/git.js'
import { cardTreeRoots } from '../../ports/worktree-home.js'
import { FREE_TREE_CAPACITY } from '../../ports/worktree.js'
import { cardSessionOf } from '../answer/answer-source.js'
import { TREE_LEFT } from '../review/review-worker.js'
import { ENDED_TREE_PATCHES, rootOfKind } from './artifact-lifetimes.js'
import { cardClosed, failureOf, parkedOrNull, treeMayBeReused } from './close-executor.js'

export const DIRTY = 'dirty'
export const UNSAVED = 'unsaved'
export const BRANCH_LEFT = 'branch left'
export const TREE_PATCH = 'tree.patch'
const MAIN_REFS = ['origin/main', 'main']
const DETACHED = 'HEAD'
const PREFIXED_TREE_NAME = /^mc-(\d+)$/
const BARE_TREE_NAME = /^(\d+)$/
const DELETED_ONLY = /^[D ]{2} /

export interface SavedTree {
  patch: string | null
  branch: string | null
}

export interface WorktreeGit {
  linked: () => string[]
  status: (tree: string) => string
  save: (tree: string, into: string) => SavedTree
  remove: (tree: string) => void
  deleteBranch: (branch: string) => void
  removeDirectory: (tree: string) => void
  prune: () => void
  park: (tree: string) => string | null
}

export interface EndedTree {
  cardId: number
  path: string
  left: string | null
  parked?: string
  patch?: string
  branch?: string
  branchLeft?: string
}

type TreeOutcome = Omit<EndedTree, 'cardId' | 'path'>

function mainRefOf(tree: string): string {
  const ref = MAIN_REFS.find(candidate => processGit.readOrNull(tree, ['rev-parse', '--verify', '--quiet', candidate]) !== null)
  if (ref === undefined)
    throw new Error(`no ${MAIN_REFS.join(' or ')} to save the branch commits against`)
  return ref
}

function uncommittedWorkOf(tree: string): string {
  if (git(tree, ['status', '--porcelain']).trim() === '')
    return ''
  git(tree, ['add', '-A'])
  const work = git(tree, ['diff', '--cached', '--binary', 'HEAD'])
  if (work === '')
    throw new Error('the tree is dirty but its work came out as an empty patch')
  return work
}

function writtenOrNull(file: string, text: string): string | null {
  if (text === '')
    return null
  writeFileSync(file, text)
  return file
}

function saveTree(tree: string, into: string): SavedTree {
  mkdirSync(into, { recursive: true })
  const head = git(tree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const commits = git(tree, ['format-patch', '--stdout', '--binary', `${mainRefOf(tree)}..HEAD`])
  return {
    patch: writtenOrNull(path.join(into, TREE_PATCH), `${commits}${uncommittedWorkOf(tree)}`),
    branch: head === DETACHED ? null : head,
  }
}

export function gitWorktrees(repo: string, capacity = FREE_TREE_CAPACITY): WorktreeGit {
  return {
    park: tree => parkedOrNull(repo, tree, capacity),
    linked: () => git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length)).slice(1),
    status: tree => git(tree, ['status', '--porcelain']),
    save: saveTree,
    remove: (tree) => {
      git(repo, ['worktree', 'remove', '--force', tree])
    },
    deleteBranch: (branch) => {
      git(repo, ['branch', '-D', branch])
    },
    removeDirectory: (tree) => {
      rmSync(tree, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
    prune: () => {
      git(repo, ['worktree', 'prune'])
    },
  }
}

function canonical(where: string): string {
  return existsSync(where) ? realpathSync(where) : path.resolve(where)
}

function changesOf(status: string): string[] {
  return status.split('\n').filter(line => line !== '')
}

function savedFields(saved: SavedTree, dropped: boolean): Pick<EndedTree, 'patch' | 'branch'> {
  return {
    ...(saved.patch === null ? {} : { patch: saved.patch }),
    ...(dropped && saved.branch !== null ? { branch: saved.branch } : {}),
  }
}

export function leasedAt(db: DatabaseSync, cardId: number, now: string): boolean {
  return tasksOfCard(db, cardId, { state: LEASED }).some(task => task.lease_until !== null && task.lease_until > now)
}

export class EndedCardTrees {
  private readonly homes: Set<string>
  private readonly bareIdHomes: Set<string>

  constructor(private readonly db: DatabaseSync, homes: string[], private readonly git: WorktreeGit, private readonly clock: () => Date, bareIdHomes: string[] = [], private readonly cwds?: () => ProcessCwds, private readonly busDir: string | null = null) {
    this.homes = new Set(homes.map(canonical))
    this.bareIdHomes = new Set(bareIdHomes.map(canonical))
  }

  free(): EndedTree[] {
    const freed = this.git.linked().filter(tree => existsSync(tree)).flatMap((tree) => {
      const cardId = this.endedOwnerOf(canonical(tree))
      return cardId === null ? [] : [{ cardId, path: tree, ...this.freeTree(tree, cardId) }]
    })
    this.git.prune()
    return freed.map(tree => this.branchFreed(tree))
  }

  private branchFreed(tree: EndedTree): EndedTree {
    if (tree.left !== null || tree.branch === undefined)
      return tree
    try {
      this.git.deleteBranch(tree.branch)
      return tree
    }
    catch (error) {
      return { ...tree, branchLeft: `${BRANCH_LEFT} ${tree.branch}: ${failureOf(error)}` }
    }
  }

  private endedOwnerOf(tree: string): number | null {
    const name = path.basename(tree)
    const home = path.dirname(tree)
    const id = (this.homes.has(home) ? PREFIXED_TREE_NAME.exec(name)?.[1] : undefined) ?? (this.bareIdHomes.has(home) ? BARE_TREE_NAME.exec(name)?.[1] : undefined)
    if (id === undefined)
      return null
    const cardId = Number(id)
    const session = cardSessionOf(this.db, cardId)
    if (session === null || canonical(session.worktree) !== tree)
      return null
    return this.ended(cardId) && !this.leased(cardId) ? cardId : null
  }

  private stateOf(cardId: number): string | null {
    return cardStatesAmong(this.db, [cardId]).get(cardId) ?? null
  }

  private ended(cardId: number): boolean {
    const state = this.stateOf(cardId)
    return state === CLOSED_CARD || state === MERGED_CARD || this.droppedAndUnheld(cardId) || cardClosed(this.db, cardId)
  }

  private droppedAndUnheld(cardId: number): boolean {
    const session = cardSessionOf(this.db, cardId)
    return this.stateOf(cardId) === DROPPED_CARD && session !== null && treeMayBeReused(this.db, cardId, session, this.cwds)
  }

  private leased(cardId: number): boolean {
    return leasedAt(this.db, cardId, this.clock().toISOString())
  }

  private parked(tree: string, cardId: number, changes: string[]): string | null {
    const session = cardSessionOf(this.db, cardId)
    if (changes.length > 0 || session === null || !treeMayBeReused(this.db, cardId, session, this.cwds))
      return null
    return this.git.park(tree)
  }

  private saved(tree: string, cardId: number): SavedTree {
    if (this.busDir === null)
      throw new Error('no bus directory to save the tree into')
    return this.git.save(tree, path.join(rootOfKind(ENDED_TREE_PATCHES, { home: path.dirname(this.busDir), busDir: this.busDir }), String(cardId)))
  }

  private freeTree(tree: string, cardId: number): TreeOutcome {
    let changes: string[]
    try {
      changes = changesOf(this.git.status(tree))
    }
    catch (error) {
      return { left: failureOf(error) }
    }
    const kept = changes.filter(line => !DELETED_ONLY.test(line))
    const dropped = this.stateOf(cardId) === DROPPED_CARD
    if (kept.length === 0 && !dropped)
      return this.parkedOrRemoved(tree, cardId, changes)
    let saved: SavedTree
    try {
      saved = this.saved(tree, cardId)
    }
    catch (error) {
      return { left: `${UNSAVED}: ${failureOf(error)}${kept.length > 0 ? `; ${DIRTY}: ${kept.join(', ')}` : ''}` }
    }
    return { ...this.removed(tree), ...savedFields(saved, dropped) }
  }

  private parkedOrRemoved(tree: string, cardId: number, changes: string[]): TreeOutcome {
    const parked = this.parked(tree, cardId, changes)
    return parked === null ? this.removed(tree) : { left: null, parked }
  }

  private removed(tree: string): TreeOutcome {
    try {
      this.git.remove(tree)
      return { left: null }
    }
    catch (error) {
      return { left: this.removeDirectory(tree, failureOf(error)) }
    }
  }

  private removeDirectory(tree: string, gitSaid: string): string | null {
    try {
      this.git.removeDirectory(tree)
      return null
    }
    catch (error) {
      return `${gitSaid}; ${failureOf(error)}`
    }
  }
}

export function cardTreeSweep(db: DatabaseSync, env: NodeJS.ProcessEnv, busPath: string, repo: string, git: WorktreeGit, clock: () => Date, cwds?: () => ProcessCwds): EndedCardTrees {
  const roots = cardTreeRoots(env, busPath, repo)
  return new EndedCardTrees(db, roots.homes, git, clock, [roots.perBus], cwds, busDirOf(busPath))
}

function treeLeft(db: DatabaseSync, actor: string, ts: string, tree: EndedTree, what: string, detail: string): void {
  appendEvent(db, { ts, type: BOARD_ALARM, actor, cardId: tree.cardId, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${TREE_LEFT}:${tree.path}${what}:${actor}`, payload: { reason: TREE_LEFT, path: tree.path, detail }, legacy: false })
}

export function recordEndedTrees(db: DatabaseSync, actor: string, ts: string, trees: EndedTree[]): void {
  for (const tree of trees) {
    if (tree.left !== null) {
      treeLeft(db, actor, ts, tree, '', tree.left)
      continue
    }
    appendEvent(db, { ts, type: ARTIFACT_REMOVED, actor, cardId: tree.cardId, pr: null, head: null, dedupeKey: `${ARTIFACT_REMOVED}:${tree.cardId}:${tree.path}`, payload: { path: tree.path, by: actor, ...(tree.parked === undefined ? {} : { parked: tree.parked }), ...(tree.patch === undefined ? {} : { patch: tree.patch }) }, legacy: false })
    if (tree.branchLeft !== undefined)
      treeLeft(db, actor, ts, tree, `:${tree.branch}`, tree.branchLeft)
  }
}
