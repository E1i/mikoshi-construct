import type { DatabaseSync } from 'node:sqlite'
import type { CardSession } from './answer-source.js'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { pnpmInstall } from '../ghosts/task-start.js'
import { taskWorktree, worktreeHome } from '../ghosts/worktree-home.js'
import { cardSessionOf, NO_RECORDED_SESSION, openPrOfCard } from './answer-source.js'

const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']

export interface CardTreeTools {
  home: string
  exists: (dir: string) => boolean
  branchOf: (pr: number) => string
  recreate: (worktree: string, branch: string) => void
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function gitCardTrees(repo: string, home: string, install: (cwd: string) => void): CardTreeTools {
  return {
    home,
    exists: existsSync,
    branchOf: pr => execFileSync('gh', ['pr', 'view', String(pr), '--json', 'headRefName', '--jq', '.headRefName'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    recreate: (worktree, branch) => {
      git(repo, ['worktree', 'prune'])
      git(repo, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
      git(repo, ['worktree', 'add', '-q', '-B', branch, worktree, `origin/${branch}`])
      install(worktree)
    },
  }
}

export function realCardTrees(): CardTreeTools {
  return gitCardTrees(process.cwd(), worktreeHome(process.env), cwd => pnpmInstall(cwd, INSTALL_ARGS))
}

export function cardTreeOf(db: DatabaseSync, cardId: number, tools: CardTreeTools): CardSession | null {
  const recorded = cardSessionOf(db, cardId)
  if (recorded !== null && tools.exists(recorded.worktree))
    return recorded
  const pr = openPrOfCard(db, cardId)
  if (pr === null)
    return recorded
  const branch = tools.branchOf(pr)
  const worktree = recorded?.worktree ?? taskWorktree(tools.home, String(cardId))
  tools.recreate(worktree, branch)
  return { session: recorded?.session ?? NO_RECORDED_SESSION, worktree, branch }
}
