import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../src/commands/attach/record.js'
import type { GitHub, GitHubPut } from '../ports/github.js'
import type { CardTask, RequestTools } from './window-requests.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { busDirOf, decisionsFileOf } from '../core/bus-path.js'
import { reportPath } from '../core/places.js'
import { pushPolicyAt } from '../core/push-policy.js'
import { reduce } from '../core/reducer.js'
import { cardSessionOf } from '../nodes/answer/answer-source.js'
import { launchDirOf } from '../nodes/launch/launch-worker.js'
import { matrixCountLineOf } from '../nodes/launch/tree-pr.js'
import { dryRunIn, dryRunReviewsDir } from '../nodes/review/dry-run-record.js'
import { PrCloser } from '../nodes/review/pr-close.js'
import { PrReopener } from '../nodes/review/pr-reopen.js'
import { CiRerunner, PrBodyFileAppender } from '../nodes/review/pr-rerun.js'
import { decisionsIntake } from '../policy/decisions-import.js'
import { busProjectsDecisions, decisionRows, expireDecisions, recordDecision, recordedNumbers, startProjectingDecisions } from '../policy/decisions.js'
import { ARCHIVE_HEADER, runDecisionsAdd } from '../policy/decisions/add.js'
import { PREFIX, projectDecisions } from '../policy/decisions/decisions.js'
import { archiveOf } from '../policy/decisions/read.js'
import { ghApi, ghApiPatch, ghApiPost } from '../ports/github.js'
import { EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_VARIABLE } from '../ports/session.js'
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
  const gitHub = ghApi(repo)
  const patch = ghApiPatch(repo)
  const pushPolicy = (): PushPolicy => pushPolicyAt(repo)
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
    addDecision: decisionsAdder(db, decisionsFileOf(busPath), () => new Date()),
    settleDecisions: decisionsSettler(db, decisionsFileOf(busPath), () => new Date()),
    causeHolds: causeHoldsIn(db, repo),
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

function readIfThere(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function writeIfChanged(file: string, before: string, after: string): void {
  if (after !== before)
    writeFileSync(file, after)
}

export function decisionsSettler(db: DatabaseSync, decisions: string, now: () => Date): NonNullable<RequestTools['settleDecisions']> {
  return () => {
    if (!busProjectsDecisions(db)) {
      decisionsIntake(db, decisions, now)()
      startProjectingDecisions(db, now())
    }
    reduce(db)
    expireDecisions(db, now())
    reduce(db)
    const archive = archiveOf(decisions)
    const [file, archived] = [readIfThere(decisions), readIfThere(archive)]
    const projected = projectDecisions(decisionRows(db), file, archived, ARCHIVE_HEADER)
    try {
      writeIfChanged(archive, archived, projected.archive)
      writeIfChanged(decisions, file, projected.file)
    }
    catch (error) {
      console.error(`${PREFIX}${decisions} not rebuilt: ${error instanceof Error ? error.message : String(error)}; the next tick tries again`)
    }
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
      held: () => recordedNumbers(db),
      settled: () => false,
      out: line => lines.push(line),
      err: line => lines.push(line),
    })
    return { code, lines }
  }
}
