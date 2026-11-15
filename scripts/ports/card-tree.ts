import type { DatabaseSync } from 'node:sqlite'
import type { CardSession } from '../nodes/answer/answer-source.js'
import type { GitHub } from './github.js'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defaultBusPath, openBus, openOwnerWait } from '../core/db.js'
import { cardSessionOf, NO_RECORDED_SESSION, openPrOfCard } from '../nodes/answer/answer-source.js'
import { processGit } from './git.js'
import { ghApi } from './github.js'
import { Meter } from './meter.js'
import { cardTree, taskWorktree, worktreeHome } from './worktree-home.js'
import { pnpmInstall, takeFreeTree } from './worktree.js'

export const TECHNOLOGY_WORDS = ['database'] as const

const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']

export interface CardTreeTools {
  home: string
  treeOf?: (cardId: string) => string
  exists: (dir: string) => boolean
  branchOf: (pr: number) => string
  recreate: (worktree: string, branch: string) => void
  bringTo: (worktree: string, branch: string, head: string) => void
}

function git(repo: string, args: string[]): string {
  return processGit.read(repo, args)
}

function headRefOf(pull: unknown, pr: number): string {
  const ref = (pull as { head?: { ref?: unknown } } | null)?.head?.ref
  if (typeof ref !== 'string' || ref === '')
    throw new Error(`GitHub names no head branch for pull request #${pr}`)
  return ref
}

export function gitCardTrees(repo: string, home: string, install: (cwd: string) => void, gitHub: GitHub = ghApi(repo), treeOf?: (cardId: string) => string): CardTreeTools {
  return {
    home,
    treeOf,
    exists: existsSync,
    branchOf: pr => headRefOf(new Meter(gitHub, Date.now).get(`repos/{owner}/{repo}/pulls/${pr}`), pr),
    recreate: (worktree, branch) => {
      git(repo, ['worktree', 'prune'])
      git(repo, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
      if (!takeFreeTree(git, repo, worktree, tree => git(tree, ['checkout', '-q', '-f', '--no-track', '-B', branch, `origin/${branch}`])))
        git(repo, ['worktree', 'add', '-q', '-B', branch, worktree, `origin/${branch}`])
      install(worktree)
    },
    bringTo: (worktree, branch, head) => bringToHead(worktree, branch, head),
  }
}

export class CardTreeRefused extends Error {}

function isAncestor(worktree: string, at: string, head: string): boolean {
  try {
    git(worktree, ['merge-base', '--is-ancestor', at, head])
    return true
  }
  catch {
    return false
  }
}

function bringToHead(worktree: string, branch: string, head: string): void {
  git(worktree, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  const at = git(worktree, ['rev-parse', 'HEAD']).trim()
  if (at === head)
    return
  const current = git(worktree, ['branch', '--show-current']).trim()
  if (current !== branch)
    throw new CardTreeRefused(`the card tree ${worktree} is on ${current || 'a detached head'}, not ${branch}; it is not brought to the task head ${head}`)
  if (isAncestor(worktree, head, at))
    return
  if (!isAncestor(worktree, at, head))
    throw new CardTreeRefused(`the card tree ${worktree} at ${at} is not behind the task head ${head}, it has commits the head lacks; it is not brought to it`)
  const uncommitted = git(worktree, ['status', '--porcelain']).trim() !== ''
  try {
    git(worktree, ['merge', '-q', '--ff-only', head])
  }
  catch (error) {
    if (!uncommitted)
      throw error
    throw new CardTreeRefused(`the card tree ${worktree} at ${at} has uncommitted changes the task head ${head} would overwrite; they are kept and the tree is not brought to it`)
  }
}

function openHeadOf(db: DatabaseSync, pr: number): string | null {
  const row = db.prepare(`SELECT head FROM prs WHERE pr = ?`).get(pr) as { head: string | null } | undefined
  return row?.head ?? null
}

export function realCardTrees(): CardTreeTools {
  return gitCardTrees(process.cwd(), worktreeHome(process.env), cwd => pnpmInstall(cwd, INSTALL_ARGS), ghApi(process.cwd()), id => cardTree(process.env, defaultBusPath(), id))
}

const BRANCH_SEPARATORS = /[^\w.-]+/g

export function cardlessTreeName(branch: string): string {
  return `branch-${branch.replace(BRANCH_SEPARATORS, '-')}`
}

export function cardlessTreeOf(branch: string, tools: CardTreeTools): string {
  const name = cardlessTreeName(branch)
  const worktree = tools.treeOf?.(name) ?? taskWorktree(tools.home, name)
  if (!tools.exists(worktree))
    tools.recreate(worktree, branch)
  return worktree
}

export type TreeRun = (cwd: string, args: readonly string[]) => { status: number | null, stderr: string }

export type TreeRerun = { kind: 'ran', outputs: ReadonlyMap<string, string | null> } | { kind: 'failed', why: string }

export interface TreeReading {
  current: (file: string) => string | null
  base: (file: string) => string | null
  rerun: (command: readonly string[], outputs: readonly string[]) => TreeRerun
}

export function pnpmRerun(cwd: string, args: readonly string[]): { status: number | null, stderr: string } {
  const run = spawnSync('pnpm', [...args], { cwd, encoding: 'utf8' })
  return { status: run.status, stderr: run.error?.message ?? run.stderr }
}

function textIn(worktree: string, file: string): string | null {
  try {
    return readFileSync(path.join(worktree, file), 'utf8')
  }
  catch {
    return null
  }
}

function putBack(worktree: string, held: ReadonlyMap<string, string | null>): void {
  for (const [file, text] of held) {
    if (text === null)
      rmSync(path.join(worktree, file), { force: true })
    else
      writeFileSync(path.join(worktree, file), text)
  }
}

export function treeReading(read: (cwd: string, args: string[]) => string, worktree: string, base: string, run: TreeRun = pnpmRerun): TreeReading {
  return {
    current: file => textIn(worktree, file),
    base: (file) => {
      try {
        return read(worktree, ['show', `${base}:${file}`])
      }
      catch {
        return null
      }
    },
    rerun: (command, outputs) => {
      const held = new Map(outputs.map(file => [file, textIn(worktree, file)]))
      try {
        const result = run(worktree, command)
        if (result.status !== 0)
          return { kind: 'failed', why: `exited ${result.status ?? 'without a status'}: ${result.stderr.trim()}` }
        return { kind: 'ran', outputs: new Map(outputs.map(file => [file, textIn(worktree, file)])) }
      }
      finally {
        putBack(worktree, held)
      }
    },
  }
}

export const DERIVED_BASE = 'origin/main'

export function cardTreeReading(db: DatabaseSync, cardId: number, tools: CardTreeTools = realCardTrees(), run: TreeRun = pnpmRerun): TreeReading | null {
  const card = cardTreeOf(db, cardId, tools)
  return card === null ? null : treeReading(git, card.worktree, DERIVED_BASE, run)
}

export type OwnerWaitOpener = (cardId: number | null, text: string) => string

export function busOwnerWait(busPath: string = defaultBusPath(), actor = `worker:shift:${process.pid}`): OwnerWaitOpener {
  return (cardId, text) => {
    const db = openBus(busPath)
    try {
      return openOwnerWait(db, new Date().toISOString(), actor, { need: 'decision', text, ...(cardId === null ? {} : { card: cardId }) })
    }
    finally {
      db.close()
    }
  }
}

export function cardTreeOf(db: DatabaseSync, cardId: number, tools: CardTreeTools): CardSession | null {
  const recorded = cardSessionOf(db, cardId)
  const pr = openPrOfCard(db, cardId)
  if (recorded !== null && tools.exists(recorded.worktree)) {
    const head = pr === null ? null : openHeadOf(db, pr)
    if (head !== null)
      tools.bringTo(recorded.worktree, recorded.branch, head)
    return recorded
  }
  if (pr === null)
    return recorded
  const branch = tools.branchOf(pr)
  const worktree = recorded?.worktree ?? tools.treeOf?.(String(cardId)) ?? taskWorktree(tools.home, String(cardId))
  if (tools.exists(worktree)) {
    const head = openHeadOf(db, pr)
    if (head !== null)
      tools.bringTo(worktree, branch, head)
  }
  else {
    tools.recreate(worktree, branch)
  }
  return { session: recorded?.session ?? NO_RECORDED_SESSION, worktree, branch }
}
