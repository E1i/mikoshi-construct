import type { DatabaseSync } from 'node:sqlite'
import type { CardSession } from './answer-source.js'
import type { GitHub } from './github.js'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { taskWorktree, worktreeHome } from '../ports/worktree-home.js'
import { pnpmInstall } from '../ports/worktree.js'
import { cardSessionOf, NO_RECORDED_SESSION, openPrOfCard } from './answer-source.js'
import { ghApi } from './github.js'
import { Meter } from './meter.js'

const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']

export interface CardTreeTools {
  home: string
  exists: (dir: string) => boolean
  branchOf: (pr: number) => string
  recreate: (worktree: string, branch: string) => void
  bringTo: (worktree: string, branch: string, head: string) => void
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function headRefOf(pull: unknown, pr: number): string {
  const ref = (pull as { head?: { ref?: unknown } } | null)?.head?.ref
  if (typeof ref !== 'string' || ref === '')
    throw new Error(`GitHub names no head branch for pull request #${pr}`)
  return ref
}

export function gitCardTrees(repo: string, home: string, install: (cwd: string) => void, gitHub: GitHub = ghApi(repo)): CardTreeTools {
  return {
    home,
    exists: existsSync,
    branchOf: pr => headRefOf(new Meter(gitHub, Date.now).get(`repos/{owner}/{repo}/pulls/${pr}`), pr),
    recreate: (worktree, branch) => {
      git(repo, ['worktree', 'prune'])
      git(repo, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
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
  if (git(worktree, ['status', '--porcelain']).trim() !== '')
    throw new CardTreeRefused(`the card tree ${worktree} at ${at} has uncommitted changes; it is not brought to the task head ${head}`)
  if (isAncestor(worktree, head, at))
    return
  if (!isAncestor(worktree, at, head))
    throw new CardTreeRefused(`the card tree ${worktree} at ${at} is not behind the task head ${head}, it has commits the head lacks; it is not brought to it`)
  git(worktree, ['merge', '-q', '--ff-only', head])
}

function openHeadOf(db: DatabaseSync, pr: number): string | null {
  const row = db.prepare(`SELECT head FROM prs WHERE pr = ?`).get(pr) as { head: string | null } | undefined
  return row?.head ?? null
}

export function realCardTrees(): CardTreeTools {
  return gitCardTrees(process.cwd(), worktreeHome(process.env), cwd => pnpmInstall(cwd, INSTALL_ARGS))
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
  const worktree = recorded?.worktree ?? taskWorktree(tools.home, String(cardId))
  tools.recreate(worktree, branch)
  return { session: recorded?.session ?? NO_RECORDED_SESSION, worktree, branch }
}
