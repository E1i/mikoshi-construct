import type { DatabaseSync } from 'node:sqlite'
import type { ProcessCwds } from '../../ports/client/contract.js'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { CLOSED_CARD, MERGED_CARD } from '../../core/card-automaton.js'
import { appendEvent } from '../../core/db.js'
import { ARTIFACT_REMOVED, BOARD_ALARM } from '../../core/events.js'
import { LEASED } from '../../core/queue.js'
import { processGit } from '../../ports/git.js'
import { cardTreeRoots } from '../../ports/worktree-home.js'
import { FREE_TREE_CAPACITY } from '../../ports/worktree.js'
import { cardSessionOf } from '../answer/answer-source.js'
import { TREE_LEFT } from '../review/review-worker.js'
import { cardClosed, failureOf, parkedOrNull, treeMayBeReused } from './close-executor.js'

export const DIRTY = 'dirty'
const PREFIXED_TREE_NAME = /^mc-(\d+)$/
const BARE_TREE_NAME = /^(\d+)$/
const DELETED_ONLY = /^[D ]{2} /

export interface WorktreeGit {
  linked: () => string[]
  status: (tree: string) => string
  remove: (tree: string) => void
  removeDirectory: (tree: string) => void
  prune: () => void
  park: (tree: string) => string | null
}

export interface EndedTree {
  cardId: number
  path: string
  left: string | null
  parked?: string
}

function git(repo: string, args: string[]): string {
  return processGit.read(repo, args)
}

export function gitWorktrees(repo: string, capacity = FREE_TREE_CAPACITY): WorktreeGit {
  return {
    park: tree => parkedOrNull(repo, tree, capacity),
    linked: () => git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length)).slice(1),
    status: tree => git(tree, ['status', '--porcelain']),
    remove: (tree) => {
      git(repo, ['worktree', 'remove', '--force', tree])
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

export class EndedCardTrees {
  private readonly homes: Set<string>
  private readonly bareIdHomes: Set<string>

  constructor(private readonly db: DatabaseSync, homes: string[], private readonly git: WorktreeGit, private readonly clock: () => Date, bareIdHomes: string[] = [], private readonly cwds?: () => ProcessCwds) {
    this.homes = new Set(homes.map(canonical))
    this.bareIdHomes = new Set(bareIdHomes.map(canonical))
  }

  free(): EndedTree[] {
    const freed = this.git.linked().filter(tree => existsSync(tree)).flatMap((tree) => {
      const cardId = this.endedOwnerOf(canonical(tree))
      return cardId === null ? [] : [{ cardId, path: tree, ...this.freeTree(tree, cardId) }]
    })
    this.git.prune()
    return freed
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

  private ended(cardId: number): boolean {
    const row = this.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined
    return row?.state === CLOSED_CARD || row?.state === MERGED_CARD || cardClosed(this.db, cardId)
  }

  private leased(cardId: number): boolean {
    return this.db.prepare('SELECT 1 FROM tasks WHERE card_id = ? AND state = ? AND lease_until > ? LIMIT 1').get(cardId, LEASED, this.clock().toISOString()) !== undefined
  }

  private parked(tree: string, cardId: number, changes: string[]): string | null {
    const session = cardSessionOf(this.db, cardId)
    if (changes.length > 0 || session === null || !treeMayBeReused(this.db, cardId, session, this.cwds))
      return null
    return this.git.park(tree)
  }

  private freeTree(tree: string, cardId: number): { left: string | null, parked?: string } {
    let changes: string[]
    try {
      changes = changesOf(this.git.status(tree))
    }
    catch (error) {
      return { left: failureOf(error) }
    }
    const kept = changes.filter(line => !DELETED_ONLY.test(line))
    if (kept.length > 0)
      return { left: `${DIRTY}: ${kept.join(', ')}` }
    const parked = this.parked(tree, cardId, changes)
    if (parked !== null)
      return { left: null, parked }
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

export function cardTreeSweep(db: DatabaseSync, env: NodeJS.ProcessEnv, busPath: string, repo: string, git: WorktreeGit, clock: () => Date): EndedCardTrees {
  const roots = cardTreeRoots(env, busPath, repo)
  return new EndedCardTrees(db, roots.homes, git, clock, [roots.perBus])
}

export function recordEndedTrees(db: DatabaseSync, actor: string, ts: string, trees: EndedTree[]): void {
  for (const tree of trees) {
    appendEvent(db, tree.left === null
      ? { ts, type: ARTIFACT_REMOVED, actor, cardId: tree.cardId, pr: null, head: null, dedupeKey: `${ARTIFACT_REMOVED}:${tree.cardId}:${tree.path}`, payload: { path: tree.path, by: actor, ...(tree.parked === undefined ? {} : { parked: tree.parked }) }, legacy: false }
      : { ts, type: BOARD_ALARM, actor, cardId: tree.cardId, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${TREE_LEFT}:${tree.path}:${actor}`, payload: { reason: TREE_LEFT, path: tree.path, detail: tree.left }, legacy: false })
  }
}
