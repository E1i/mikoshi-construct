import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../src/commands/attach/record.js'
import type { GitHub, GitHubPut } from '../ports/github.js'
import type { CardTask, RequestTools } from './window-requests.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import { busDirOf } from '../core/bus-path.js'
import { CARD_BODIES } from '../core/card-bodies.js'
import { reportPath } from '../core/places.js'
import { pushPolicyOf } from '../core/push-policy.js'
import { cardSessionOf } from '../nodes/answer/answer-source.js'
import { launchDirOf } from '../nodes/launch/launch-worker.js'
import { matrixCountLineOf } from '../nodes/launch/tree-pr.js'
import { dryRunIn, dryRunReviewsDir } from '../nodes/review/dry-run-record.js'
import { PrCloser } from '../nodes/review/pr-close.js'
import { PrReopener } from '../nodes/review/pr-reopen.js'
import { CiRerunner, PrBodyFileAppender } from '../nodes/review/pr-rerun.js'
import { decisionsAdderOfBus, decisionsSettlerOfBus } from '../policy/decisions/projection.js'
import { processGit, readThroughPort } from '../ports/git.js'
import { ghApi, ghApiPatch, ghApiPost } from '../ports/github.js'
import { EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_VARIABLE } from '../ports/session.js'
import { cardTree } from '../ports/worktree-home.js'

const WORKTREE_LINE = /^worktree (.+)$/
const BRANCH_LINE = /^branch refs\/heads\/(.+)$/

function git(repo: string, args: string[]): string {
  return processGit.read(repo, args)
}

export function worktreesHolding(porcelain: string, branch: string): string[] {
  return porcelain.split('\n\n').flatMap((block) => {
    const lines = block.split('\n')
    const tree = lines.map(line => WORKTREE_LINE.exec(line)?.[1]).find(found => found !== undefined)
    const held = lines.map(line => BRANCH_LINE.exec(line)?.[1]).find(found => found !== undefined)
    return tree !== undefined && held === branch ? [tree] : []
  })
}

function branchOfBody(db: DatabaseSync, cardId: number): string | null {
  const row = db.prepare(`SELECT branch FROM ${CARD_BODIES} WHERE card_id = ?`).get(cardId) as { branch: string | null } | undefined
  return row?.branch ?? null
}

function standingTreeOf(db: DatabaseSync, cardId: number, treeOf: (cardId: number) => string): { worktree: string, branch: string } | null {
  const recorded = cardSessionOf(db, cardId)
  if (recorded !== null)
    return recorded
  const worktree = treeOf(cardId)
  const branch = branchOfBody(db, cardId)
  return branch === null || !existsSync(worktree) ? null : { worktree, branch }
}

function canonical(tree: string): string {
  return existsSync(tree) ? realpathSync(tree) : tree
}

function causeHoldsIn(db: DatabaseSync, repo: string, treeOf: (cardId: number) => string): (task: CardTask) => string | null {
  return (task) => {
    const card = standingTreeOf(db, task.cardId, treeOf)
    if (card === null)
      return null
    const own = canonical(card.worktree)
    const holders = worktreesHolding(git(repo, ['worktree', 'list', '--porcelain']), card.branch)
    const other = holders.find(tree => canonical(tree) !== own)
    if (other !== undefined)
      return `${card.branch} is checked out at ${other}`
    if (holders.some(tree => canonical(tree) === own) && git(card.worktree, ['status', '--porcelain']).trim() !== '')
      return `the card tree ${card.worktree} has uncommitted changes`
    return null
  }
}

export function realRequestTools(db: DatabaseSync, busPath: string, repo: string, env: NodeJS.ProcessEnv, projections: Parameters<typeof decisionsSettlerOfBus>[3]): RequestTools {
  const gitHub = ghApi(repo)
  const patch = ghApiPatch(repo)
  const pushPolicy = (): PushPolicy => pushPolicyOf(readThroughPort, repo)
  const closer = new PrCloser(db, gitHub, patch, () => new Date(), pushPolicy)
  const reopener = new PrReopener(db, gitHub, patch, () => new Date(), pushPolicy)
  const treeOf = (cardId: number): string => cardTree(env, busPath, String(cardId))
  const parts = { db, gitHub, clock: () => new Date(), pushPolicy }
  const rerunner = new CiRerunner(parts, ghApiPost(repo))
  const bodyAppender = new PrBodyFileAppender(parts, patch, treeOf)
  return {
    treeOf,
    exists: existsSync,
    cutTree: (branch, cardLine) => {
      execFileSync('pnpm', ['--silent', 'task:start', branch, '--card', cardLine], { cwd: repo, env: { ...env, [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    },
    dryRunOf: dryRunIn(dryRunReviewsDir(busDirOf(busPath))),
    addDecision: decisionsAdderOfBus(db, busPath, () => new Date()),
    settleDecisions: decisionsSettlerOfBus(db, busPath, () => new Date(), projections),
    causeHolds: causeHoldsIn(db, repo, treeOf),
    closePr: request => closer.close(request),
    closeDropped: () => closer.closeDropped(),
    appendCountLine: countLineAppender(gitHub, patch, launchDirOf(os.homedir(), busPath), pushPolicy),
    reopenPr: (request) => {
      const outcome = reopener.reopen(request)
      return { done: outcome.kind === 'reopened', why: outcome.detail }
    },
    appendBodyFile: (attempt, pr, file) => bodyAppender.append(attempt, pr, file),
    rerunCi: (attempt, pr) => rerunner.rerun(attempt, pr),
  }
}

export function countLineAppender(gitHub: GitHub, patch: GitHubPut, launchDir: string, pushPolicy: () => PushPolicy): NonNullable<RequestTools['appendCountLine']> {
  return (pr, cardId) => {
    if (pushPolicy() === 'none')
      return { done: false, why: `push policy none: the bus does not change the body of PR #${pr}` }
    const report = reportPath(launchDir, String(cardId))
    if (!existsSync(report))
      return { done: false, why: `card #${cardId} has no report at ${report}, so no count line to append to PR #${pr}` }
    const countLine = matrixCountLineOf(readFileSync(report, 'utf8'))
    if (countLine === undefined)
      return { done: false, why: `${report} holds no count line ■ n □ n · n, so nothing is appended to PR #${pr}` }
    const endpoint = `repos/{owner}/{repo}/pulls/${pr}`
    const read = gitHub(endpoint)
    if (read.status !== 200)
      return { done: false, why: `GitHub answered ${read.status} to the read of PR #${pr}` }
    const body = String((read.body as { body?: unknown } | null)?.body ?? '')
    const held = matrixCountLineOf(body)
    if (held !== undefined)
      return { done: false, why: `PR #${pr} already holds the count line ${held}` }
    const written = patch(endpoint, { body: `${body}\n\n${countLine}` })
    return written.status === 200
      ? { done: true, why: `appended ${countLine} from ${report} to PR #${pr}` }
      : { done: false, why: `GitHub answered ${written.status} to the write of the body of PR #${pr}` }
  }
}
