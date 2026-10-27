import type { DatabaseSync } from 'node:sqlite'
import type { CardTask, RequestTools } from './window-requests.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { busDirOf, decisionsFileOf } from '../core/bus-path.js'
import { pushPolicyAt } from '../core/push-policy.js'
import { cardSessionOf } from '../nodes/answer/answer-source.js'
import { dryRunIn, dryRunReviewsDir } from '../nodes/review/dry-run-record.js'
import { PrCloser } from '../nodes/review/pr-close.js'
import { recordDecision } from '../policy/decisions.js'
import { runDecisionsAdd } from '../policy/decisions/add.js'
import { ghApi, ghApiPatch } from '../ports/github.js'
import { cardTree } from '../ports/worktree-home.js'

const WORKTREE_LINE = /^worktree (.+)$/
const BRANCH_LINE = /^branch refs\/heads\/(.+)$/

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function worktreesHolding(porcelain: string, branch: string): string[] {
  return porcelain.split('\n\n').flatMap((block) => {
    const lines = block.split('\n')
    const tree = lines.map(line => WORKTREE_LINE.exec(line)?.[1]).find(found => found !== undefined)
    const held = lines.map(line => BRANCH_LINE.exec(line)?.[1]).find(found => found !== undefined)
    return tree !== undefined && held === branch ? [tree] : []
  })
}

function causeHoldsIn(db: DatabaseSync, repo: string): (task: CardTask) => string | null {
  return (task) => {
    const card = cardSessionOf(db, task.cardId)
    if (card === null)
      return null
    const holders = worktreesHolding(git(repo, ['worktree', 'list', '--porcelain']), card.branch)
    const other = holders.find(tree => tree !== card.worktree)
    if (other !== undefined)
      return `${card.branch} is checked out at ${other}`
    if (holders.includes(card.worktree) && git(card.worktree, ['status', '--porcelain']).trim() !== '')
      return `the card tree ${card.worktree} has uncommitted changes`
    return null
  }
}

export function realRequestTools(db: DatabaseSync, busPath: string, repo: string, env: NodeJS.ProcessEnv): RequestTools {
  const closer = new PrCloser(db, ghApi(repo), ghApiPatch(repo), () => new Date(), () => pushPolicyAt(repo))
  return {
    treeOf: cardId => cardTree(env, busPath, String(cardId)),
    exists: existsSync,
    cutTree: (branch, cardLine) => {
      execFileSync('pnpm', ['--silent', 'task:start', branch, '--card', cardLine], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    },
    dryRunOf: dryRunIn(dryRunReviewsDir(busDirOf(busPath))),
    addDecision: decisionsAdder(db, decisionsFileOf(busPath), () => new Date()),
    causeHolds: causeHoldsIn(db, repo),
    closePr: request => closer.close(request),
    closeDropped: () => closer.closeDropped(),
  }
}

export function decisionsAdder(db: DatabaseSync, decisions: string, now: () => Date): RequestTools['addDecision'] {
  return (args) => {
    const lines: string[] = []
    const code = runDecisionsAdd(args, {
      decisions,
      now,
      exists: existsSync,
      read: file => readFileSync(file, 'utf8'),
      write: (file, text) => writeFileSync(file, text),
      remove: unlinkSync,
      record: decision => recordDecision(db, decision),
      settled: () => false,
      out: line => lines.push(line),
      err: line => lines.push(line),
    })
    return { code, lines }
  }
}
