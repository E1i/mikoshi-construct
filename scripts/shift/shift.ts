import type { ShiftTask } from '../../src/card/task-file.js'
import type { Signal, SignalStyle } from '../../src/ui/signal.js'
import type { GhRunner } from '../board/gh.js'
import type { HandedContract, TaskStartDeps, TaskStartJournalReader } from '../ghosts/task-start.js'
import type { ClaudeExit, ClaudeRun } from './claude.js'
import type { ExitReason, SessionEvidence } from './continuation.js'
import type { LadderFacts, LadderStep } from './ladder.js'
import type { MergeResult } from './merge.js'
import type { Notify } from './notify.js'
import type { Outcome } from './outcomes.js'
import type { OpenPr } from './overlap.js'
import type { Choice, InReview, Stop } from './parking.js'
import type { TaskLine } from './places.js'
import type { PromptPlaces } from './prompt.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { closedTasks, mergedTasks } from '../../src/card/closed.js'
import { cardTerms } from '../../src/card/grammar.js'
import { parseParkingFile, SHIFT_WHO } from '../../src/card/parking.js'
import { parseTaskFile, TASK_FILE } from '../../src/card/task-file.js'
import { cheapClass, cheapForecastOf, claudeProjectsDir } from '../../src/commands/cost/index.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { execGh, prDetails } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { VERIFICATION_WORDS } from '../board/verification.js'
import { formatCheapExpect } from '../ghosts/cheap-expect.js'
import { CLOUD_VARIABLE, cloudOn } from '../ghosts/cloud-key.js'
import { missingFields } from '../ghosts/handoff-check.js'
import { PREFIX as CLOSE_PREFIX, runTaskClose } from '../ghosts/task-close.js'
import { MERGED_FILE, mergedDetails, mergedSummary, recordMerges } from '../ghosts/task-merged.js'
import { pnpmInstall, readJournalFile, runTaskStart } from '../ghosts/task-start.js'
import { startedTree } from '../ghosts/tasks.js'
import { reviewOf } from '../ghosts/verdict.js'
import { CLAUDE_VARIABLE, runClaude } from './claude.js'
import { BOUNDARY_LINE, continuationRefusal, continues, eddiesEvidence, EXIT_REASON_TEXT, exitReason, MAX_RESTARTS, QUESTION_LINE } from './continuation.js'
import { approvedSha256Of, briefBody, briefPathOf, isLadder, ladderStep, reviewBody, tasksFilePathOf, tasksFileText } from './ladder.js'
import { COMMIT_FLAG, isListed, latestPrReview, PREFIX as MERGE_PREFIX, OWNER_MERGES_ON_MAIN, passedAt, runMerge, VERDICT_FLAG } from './merge.js'
import { osascriptNotify } from './notify.js'
import { OUTCOMES_FILE, outcomesPath, outcomesTable, skippedOutcomes } from './outcomes.js'
import { openPrWarnings, taskConflicts } from './overlap.js'
import { choose, FAILED_AT, failedCards, isClosed, LADDER_REASON, latestStops, leftLine, leftSummary, nextInPipeline, QUEUE_FILE, queueText, standingStops } from './parking.js'
import { eddiesJournalPath, exitedWithoutReport, GHOST_JOURNAL, logPath, REPO, reportPath, SHIFT_JOURNAL, succeeded } from './places.js'
import { continuationBody, renderPrompt } from './prompt.js'
import { delegatedMerge, shardRefusal, slotRefusal, usedLine } from './shard.js'

export const PREFIX = '[shift] '
export const CHAIN_WAIT_MINUTES = 120
export const CHAIN_LIMIT_MINUTES = 600
export const CHAIN_CARDS = 20
const CHAIN_POLL_MS = 60_000
const MINUTE_MS = 60_000
const CHAIN_VALUED = ['--chain-wait', '--chain-limit', '--chain-cards']
const REPORT_PR_LINE = /^PR #(\d+)\s*$/m
const REPORT_VERIFICATION_LINE = /^verification:\s*(\S+)\s*$/m
const REPORT_FILE_LINE = /(?:^Report:|report written to)\s+`?([^`\s]+?)`?[.,;]?\s*$/im
export const USAGE = [
  'usage: pnpm shift <dir> [--parking <parking>] [--check] [--queue]',
  '  [--manual]  (optional: no automation; every take and every continuation asks first)',
  '  [--slot <shard>]  (optional: consumes the owner\'s shard for this run; see below)',
  '',
  'Runs every NN.md in <dir> in order, each as a fresh headless claude session in its own tree cut by task:start.',
  `With --parking, the tasks come from <parking>/<id>.md instead: the same header plus who: and an optional priority: p0.`,
  `The shift takes every card with who: ${SHIFT_WHO} whose depends are merged in the journal and which is not closed itself,`,
  'p0 first, then by id, and leaves a card whose touches overlap one already taken; <dir> keeps the journal and the reports.',
  `It prints the cards it takes and one line counting the cards it leaves by reason; the full list goes to <dir>/${QUEUE_FILE}, and --queue prints it without the closed cards.`,
  'A task file starts with a header and a blank line, then the prompt:',
  '  card: #<id> <name> [<kind>/<milestone>/<size>/<contour>/<decision>] · depends <#id …|—> · blocks <#id …|—>',
  '  branch: <branch>',
  '  touches: <path>, <dir>/**',
  '  continue: auto | stop   (optional, default stop)',
  `With continue: auto, a session that leaves on an Eddies warn, or exits 0 at a boundary its report names with a boundary: line, while its task is open is followed by a new session in the same tree that reads the handoff and goes on, at most ${MAX_RESTARTS} times.`,
  '',
  'Recommended layout: one directory per shift, e.g. ~/.construct/shift/2026-10-03-1500/.',
  `${CLAUDE_VARIABLE} is the claude command, without caffeinate, e.g.:`,
  `  ${CLAUDE_VARIABLE}='GH_TOKEN=$(gh auth token --user E1i) claude --permission-mode auto'`,
  'Keep the Mac awake for the whole runner, not only for each claude session, or it sleeps between tasks:',
  '  caffeinate -dis pnpm shift <dir>',
  `A real shift records merged pull requests as merge lines before it chooses and once after its last task, prints one merged line each time and the details to <dir>/${MERGED_FILE};`,
  'a pull request without a card, or closed without merge, is recorded as a merge-skip line and not looked up again.',
  '--check parses the tasks and checks touches against each other and the open pull requests, records no merge line, and starts nothing.',
  'The shift is an autopilot by default: it takes the next ready card, follows a session into a new one at a boundary the card allows, arms auto-merge where the merge rules allow it,',
  'and stops only at a gate the owner holds, writing one event:stop line to ghosts.jsonl (at: hash, merge, question, boundary or fault, and why).',
  'A ladder card (implement, contour ladder) with who: shift is taken like a cheap card and walked step by step: the brief in a session, the approval by MORSE (ghosts:hash --by morse; an R1 brief or a refusal stops at hash and waits for the owner),',
  'ghosts:launch with a yes on stdin and no session, then the review and the pull request in a session in the same tree. A card whose latest stop still stands (its tree exists) is left as waits <at>.',
  '--manual turns the automation off for this run only: nothing is taken and nothing is continued without a yes from the prompt; with no terminal every answer is no.',
  'Every real run writes one event:autopilot line (state on or off) to <dir>/shift.jsonl, right after its start line and before it takes its first card.',
  '--slot <shard> consumes the shard pnpm shard <dir> issued for this run, writing its shard-used line before the first card: an owner pull request whose report asks nothing,',
  'whose session no guard refused and did not stop on its Eddies budget, and whose required checks are not red or unknown is armed with auto-merge, and ghosts.jsonl gets owner decision delegated, shard <id>.',
  'A version pull request (changeset-release/*) stays the owner\'s; --slot refuses a run that is not INIT (construct.json without .construct/attach.json) and a shard used once.',
  '--chain (with --parking) makes the run a pipeline: once a card closes with a pull request, that pull request is in review and the chain takes the next card whose depends are merged and whose touches overlap no card in review;',
  'a card that overlaps one waits until that one merges and is then cut by task:start from a fresh origin/main. Merges are recorded as pnpm task:merged does, holding through a closed terminal (SIGHUP).',
  `The chain arms auto-merge on a pull request only after its review verdict: pnpm shift:merge <N> ${VERDICT_FLAG} pass writes an event:pr-review line at the head of the pull request, and the merge rules then apply; a ladder card's review is its review step. The review depth follows the card's risk (reviewDepth in scripts/ghosts/verdict.ts): R4 none, so the chain arms after CI with no verdict; R3 a diff review; R1 and R2 the full review.`,
  'An owner pull request is merged by the owner (or armed under --slot after its review) and the chain waits for it. Every step is an event:chain line in ghosts.jsonl (step wait, reviewed, merged, next or end); after an end that is not a pull request\'s own, the chain takes no card and waits for the ones in review.',
  `The chain ends itself with an end line naming the reason: no-eligible, merge-timeout (--chain-wait <minutes>, default ${CHAIN_WAIT_MINUTES}), time-limit (--chain-limit <minutes>, default ${CHAIN_LIMIT_MINUTES}), card-budget (--chain-cards <n>, default ${CHAIN_CARDS}), eddies-budget (a session stopped on its Eddies budget), question, guard-refusal, red-check (a required check red while waiting), pr-closed (closed without a merge) or stop-<hash|boundary>.`,
  'A card that fails (a fault stop that is not a guard refusal or an Eddies stop) does not end the run on its first fault (no second attempt): its stop carries failed: true and the last line of its session log as last, a card that depends on it is left as depends failed #N, the other cards go on, and a notifier (osascript display notification on macOS, nothing elsewhere) names the card, the reason and the shift report.',
  `At the end the run writes <dir>/${OUTCOMES_FILE}, one row per card it ran and per card skipped: card · result (done, failed, skipped, stop <at>, stop not-started, stop <chain end>) · reason · PR, and notifies once more.`,
  'A chain spawns its sessions detached, as the Ghost supervisor does, so a closed terminal stops neither the runner nor the session it is waiting on.',
  'Afterwards: pnpm shift:report <dir>.',
].join('\n')

export interface PnpmResult {
  code: number
  stdout: string
  stderr: string
}

export interface ShiftDeps {
  cwd: string
  claude: string | undefined
  header: string
  handoffDir: string
  readJournal: TaskStartJournalReader
  projectsDir: string
  git: TaskStartDeps['git']
  install: TaskStartDeps['install']
  gh: GhRunner
  listDir: (dir: string) => string[]
  read: (file: string) => string
  exists: (target: string) => boolean
  append: (file: string, text: string) => void
  now: () => Date
  uuid: () => string
  confirm?: (question: string) => Promise<boolean>
  pnpm?: (cwd: string, args: string[], input?: string) => PnpmResult
  run: (run: ClaudeRun) => Promise<ClaudeExit>
  out: (line: string) => void
  err: (line: string) => void
  style?: SignalStyle
  cloud?: boolean
  sleep?: (ms: number) => Promise<void>
  holdHangup?: () => () => void
  notify?: Notify
}

function refuse(deps: ShiftDeps, lines: string[]): number {
  for (const line of lines)
    deps.err(`${PREFIX}${line}`)
  return 1
}

function taskFiles(deps: ShiftDeps, dir: string): string[] {
  return deps.listDir(dir).filter(file => TASK_FILE.test(file)).sort((a, b) => Number(TASK_FILE.exec(a)![1]) - Number(TASK_FILE.exec(b)![1]) || a.localeCompare(b))
}

function readTasks(deps: ShiftDeps, dir: string): { tasks: ShiftTask[], errors: string[] } {
  const parsed = taskFiles(deps, dir).map(file => parseTaskFile(file, deps.read(path.join(dir, file))))
  return {
    tasks: parsed.flatMap(entry => entry.kind === 'task' ? [entry.task] : []),
    errors: parsed.flatMap(entry => entry.kind === 'refused' ? [entry.reason] : []),
  }
}

function approvedBrief(deps: ShiftDeps, task: ShiftTask): boolean {
  return approvedSha256Of(briefFacts(deps, task), task.card) !== null
}

function createdFile(deps: ShiftDeps): (file: string) => boolean {
  return (file) => {
    try {
      const inTree = deps.git(deps.cwd, ['ls-tree', '--name-only', 'origin/main', '--', file]).trim() !== ''
      return !inTree && !isListed(file, deps.git(deps.cwd, ['show', OWNER_MERGES_ON_MAIN]))
    }
    catch {
      return false
    }
  }
}

function readParking(deps: ShiftDeps, parking: string): { choice: Choice, errors: string[] } {
  const parsed = taskFiles(deps, parking).map(file => parseParkingFile(file, deps.read(path.join(parking, file))))
  const journal = path.join(deps.handoffDir, GHOST_JOURNAL)
  const text = deps.exists(journal) ? deps.read(journal) : null
  const done = new Set(closedTasks(text).keys())
  const cards = parsed.flatMap(entry => entry.kind === 'parked' ? [entry.parked] : [])
  const ladder = new Map(cards.filter(parked => isLadder(parked.task.card)).map(parked => [parked.task.id, parked.task]))
  const released = (stop: Stop): boolean => stop.at === 'hash' && ladder.has(stop.task) && approvedBrief(deps, ladder.get(stop.task)!)
  const stops = latestStops(text)
  const standing = standingStops(stops, deps.exists, released)
  return {
    choice: choose(cards, done, mergedTasks(text), standing, createdFile(deps), failedCards(stops, standing)),
    errors: parsed.flatMap(entry => entry.kind === 'refused' ? [entry.reason] : []),
  }
}

const MERGE_HINT = `${PREFIX}hint: depends are met by merge lines; run pnpm task:merged to record merged pull requests`

function sweepMerges(deps: ShiftDeps, journal: string, dir: string): void {
  try {
    const result = recordMerges({ gh: deps.gh, journal, readJournal: deps.readJournal, append: deps.append, now: deps.now })
    const summary = mergedSummary(result)
    if (summary === null)
      return
    deps.append(path.join(dir, MERGED_FILE), mergedDetails(result).map(line => `${line}\n`).join(''))
    deps.err(`${PREFIX}${summary}; details in ${path.join(dir, MERGED_FILE)}`)
  }
  catch (error) {
    deps.err(`${PREFIX}merged: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

function choiceLines(choice: Choice, queue: boolean): string[] {
  const taken = choice.chosen.length === 0 ? 'none' : choice.chosen.map(task => `#${task.id}`).join(', ')
  const listed = queue ? choice.left.filter(card => !isClosed(card)).map(card => `${PREFIX}parking: ${leftLine(card)}`) : []
  return [`${PREFIX}parking: takes ${taken}`, `${PREFIX}parking: ${leftSummary(choice.left)}`, ...listed]
}

function openPrs(gh: GhRunner): OpenPr[] | string {
  try {
    const listed = JSON.parse(gh(['pr', 'list', '-R', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,files'])) as { number: number, headRefName: string, files: { path: string }[] | null }[]
    return listed.map(pr => ({ number: pr.number, headRefName: pr.headRefName, files: (pr.files ?? []).map(file => file.path) }))
  }
  catch (error) {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
  }
}

function warnOpenPrs(deps: ShiftDeps, tasks: ShiftTask[]): void {
  const prs = openPrs(deps.gh)
  if (typeof prs === 'string') {
    deps.err(`${PREFIX}warning: open pull requests not read (${prs}); touches checked only between tasks`)
    return
  }
  for (const line of openPrWarnings(tasks, prs))
    deps.err(`${PREFIX}warning: ${line}`)
}

function sessionEvidence(deps: ShiftDeps, task: ShiftTask, places: Places, session: string, exit: number | null): SessionEvidence {
  const { worktree } = places
  const readIfThere = (file: string): string => deps.exists(file) ? deps.read(file) : ''
  const report = readIfThere(places.report)
  return {
    exit,
    closed: closedTasks(readIfThere(path.join(deps.handoffDir, GHOST_JOURNAL))).has(task.id),
    question: QUESTION_LINE.test(report),
    boundary: BOUNDARY_LINE.test(report),
    ...eddiesEvidence(readIfThere(eddiesJournalPath(worktree)), session),
  }
}

type HeldBy = 'guard-refusal' | 'eddies-stop'

type ShiftTaskLine = TaskLine & { merge?: string[], steps?: string[], pr?: number, heldBy?: HeldBy }

function heldBy(evidence: { refused: boolean, stopped: boolean }): { heldBy?: HeldBy } {
  if (evidence.refused)
    return { heldBy: 'guard-refusal' }
  if (evidence.stopped)
    return { heldBy: 'eddies-stop' }
  return {}
}

function mergeAfterSession(deps: ShiftDeps, number: string, reviewed: string | undefined): string[] {
  let result: MergeResult
  try {
    result = runMerge([number], {
      gh: deps.gh,
      ownerMergesText: () => {
        deps.git(deps.cwd, ['fetch', 'origin', 'main'])
        return deps.git(deps.cwd, ['show', OWNER_MERGES_ON_MAIN])
      },
    }, reviewed)
  }
  catch (error) {
    return [`${MERGE_PREFIX}PR #${number} not merged: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]!}`]
  }
  return [...result.stdout, ...result.stderr]
}

function notClosed(deps: ShiftDeps, task: ShiftTask, reason: string): string {
  return (deps.style ?? PLAIN_STYLE).paint('red', `${PREFIX}#${task.id} not closed: ${reason}`)
}

function closeFromReport(deps: ShiftDeps, task: ShiftTask, session: { worktree: string, id: string }, text: string, outcome: ['--pr' | '--report', string]): string[] {
  const word = REPORT_VERIFICATION_LINE.exec(text)?.[1]
  if (word === undefined)
    return [notClosed(deps, task, `the report has no verification: <word> line, one of ${VERIFICATION_WORDS.join(', ')}; no closing line written`)]
  const closed = runTaskClose([task.id, ...outcome, '--verification', word], {
    cwd: session.worktree,
    read: file => deps.exists(file) ? deps.read(file) : null,
    append: deps.append,
    now: deps.now,
    handoffDir: deps.handoffDir,
    exists: deps.exists,
    session: session.id,
    projectsDir: deps.projectsDir,
    style: deps.style,
  })
  return closed.exitCode === 0 ? closed.stdout : closed.stderr.map(line => notClosed(deps, task, line.slice(CLOSE_PREFIX.length)))
}

function closeProbeFromReport(deps: ShiftDeps, task: ShiftTask, session: { worktree: string, id: string }, text: string): void {
  const written = REPORT_FILE_LINE.exec(text)?.[1]
  const lines = written === undefined
    ? [notClosed(deps, task, 'the probe report has no Report: <path> line; no closing line written')]
    : closeFromReport(deps, task, session, text, ['--report', written])
  for (const line of lines)
    deps.out(line)
}

const WAITING_FOR_THE_OWNER = /^[\s*_>-]*Waiting for the owner\b/m

function asksTheOwner(report: string): boolean {
  return QUESTION_LINE.test(report) || WAITING_FOR_THE_OWNER.test(report)
}

interface Delegation {
  shard: string | undefined
  refused: boolean
  stopped: boolean
  afterReview: boolean
  reviewed?: string
}

const LEFT_TO_THE_OWNER = /merge is Eli's$/

function mergeLines(deps: ShiftDeps, task: ShiftTask, number: string, text: string, delegation: Delegation): string[] {
  if (asksTheOwner(text))
    return [`${MERGE_PREFIX}PR #${number} not armed: the report asks the owner; the merge waits for the owner's answer`]
  if (delegation.afterReview) {
    const { risk, depth } = reviewOf(task.touches)
    return [`${MERGE_PREFIX}PR #${number} waits for its review verdict, a ${depth} review at risk ${risk}: the chain arms it after pnpm shift:merge ${number} ${VERDICT_FLAG} pass ${COMMIT_FLAG} <its head>`]
  }
  const lines = mergeAfterSession(deps, number, delegation.reviewed)
  const { shard } = delegation
  if (shard === undefined || lines.length === 0 || !lines.every(line => LEFT_TO_THE_OWNER.test(line)))
    return lines
  if (delegation.refused)
    return [...lines, `${MERGE_PREFIX}PR #${number} a guard refused in the session; shard ${shard} not applied, merge is Eli's`]
  if (delegation.stopped)
    return [...lines, `${MERGE_PREFIX}PR #${number} the session stopped on its Eddies budget; shard ${shard} not applied, merge is Eli's`]
  return [...lines, ...delegatedMerge({ gh: deps.gh, journal: path.join(deps.handoffDir, GHOST_JOURNAL), append: deps.append, now: deps.now }, task.id, number, shard, delegation.reviewed)]
}

function mergeFromReport(deps: ShiftDeps, task: ShiftTask, session: { worktree: string, id: string }, report: string, delegation: Delegation): { pr: string, lines: string[] } | undefined {
  const text = deps.read(report)
  if (task.card.kind === 'probe') {
    closeProbeFromReport(deps, task, session, text)
    return undefined
  }
  const pr = REPORT_PR_LINE.exec(text)
  if (pr === null)
    return undefined
  for (const line of closeFromReport(deps, task, session, text, ['--pr', pr[1]!]))
    deps.out(line)
  const lines = mergeLines(deps, task, pr[1]!, text, delegation)
  deps.append(report, `\n${lines.join('\n')}\n`)
  for (const line of lines)
    deps.out(line)
  return { pr: pr[1]!, lines }
}

interface StopRecord {
  at: Stop['at']
  why: string
  worktree: string | null
  session: string | null
  pr?: number
  last?: string
  failed?: true
}

const MERGE_ARMED = /auto-merge armed on PR #\d+/
const AWAITS_REVIEW = /PR #\d+ waits for its review verdict/
const QUESTION_TEXT = /^question:[ \t]*(\S.*)$/m

async function confirmed(deps: ShiftDeps, question: string): Promise<boolean> {
  try {
    return deps.confirm === undefined ? false : await deps.confirm(question)
  }
  catch {
    return false
  }
}

async function takeAllowed(deps: ShiftDeps, task: ShiftTask, manual: boolean): Promise<boolean> {
  return !manual || await confirmed(deps, `take #${task.id} ${task.card.name} (${task.card.contour}/${task.card.decision})?`)
}

async function continueAllowed(deps: ShiftDeps, task: ShiftTask, reason: ExitReason, manual: boolean): Promise<boolean> {
  return !manual || await confirmed(deps, `continue #${task.id} in a new session (${EXIT_REASON_TEXT[reason]})?`)
}

function autopilotLine(deps: ShiftDeps, dir: string, manual: boolean): string {
  return `${JSON.stringify({ event: 'autopilot', state: manual ? 'off' : 'on', shift: dir, ts: deps.now().toISOString() })}\n`
}

function recordStop(deps: ShiftDeps, dir: string, task: string, stop: StopRecord): void {
  const line = { event: 'stop', task, at: stop.at, why: stop.why, worktree: stop.worktree, shift: dir, session: stop.session, ts: deps.now().toISOString(), ...(stop.pr === undefined ? {} : { pr: stop.pr }), ...(stop.last === undefined ? {} : { last: stop.last }), ...(stop.failed === undefined ? {} : { failed: stop.failed }) }
  deps.append(path.join(deps.handoffDir, GHOST_JOURNAL), `${JSON.stringify(line)}\n`)
}

function boundaryWhy(task: ShiftTask, reason: ExitReason, restarts: number, handoff: string | null, report: string): string | null {
  if (reason !== 'boundary' && reason !== 'eddies-warn')
    return null
  if (task.continue === 'stop')
    return `${EXIT_REASON_TEXT[reason]}; the card says continue: stop`
  if (restarts < MAX_RESTARTS && handoff === null)
    return `${EXIT_REASON_TEXT[reason]}; the session wrote no shift report at ${report}, so no session continues from it`
  const missing = missingFields(handoff ?? '')
  if (restarts < MAX_RESTARTS && missing.length > 0)
    return `${EXIT_REASON_TEXT[reason]}; the handoff lacks ${missing.map(field => field.label).join(', ')}, so no session continues from it`
  const refused = continuationRefusal(handoff ?? '')
  if (restarts < MAX_RESTARTS && refused !== null)
    return `${EXIT_REASON_TEXT[reason]}; ${refused}, so no session continues from it`
  return `${EXIT_REASON_TEXT[reason]}; ${restarts} of ${MAX_RESTARTS} restarts used`
}

interface Finish {
  reason: ExitReason
  halted: string | null
  exit: Extract<ClaudeExit, { kind: 'exited' }>
  report: string | null
  merge: { pr: string, lines: string[] } | undefined
  closed: boolean
}

type Where = Pick<StopRecord, 'worktree' | 'session'>

function stopAt(where: Where, kind: Stop['at'], why: string, pr?: number): StopRecord {
  return { at: kind, why, ...where, ...(pr === undefined ? {} : { pr }) }
}

function askedStop(where: Where, finish: Pick<Finish, 'reason' | 'report'>): StopRecord | null {
  return finish.reason === 'owner-question' ? stopAt(where, 'question', QUESTION_TEXT.exec(finish.report ?? '')?.[1]?.trim() || EXIT_REASON_TEXT[finish.reason]) : null
}

function interruptedStop(where: Where, finish: Pick<Finish, 'reason' | 'halted' | 'exit'>): StopRecord | null {
  const { reason, halted, exit } = finish
  if (halted !== null)
    return stopAt(where, 'boundary', halted)
  if (reason === 'eddies-stop' || reason === 'guard-refusal')
    return stopAt(where, 'fault', EXIT_REASON_TEXT[reason])
  if (exit.signal !== null || exit.code !== 0)
    return stopAt(where, 'fault', exit.signal === null ? `exit ${exit.code}` : `signal ${exit.signal}`)
  return null
}

function stopAfter(task: ShiftTask, where: Where, finish: Finish): StopRecord | null {
  const { report, merge } = finish
  const asked = askedStop(where, finish)
  if (asked !== null)
    return asked
  if (merge?.lines.some(line => MERGE_ARMED.test(line) || AWAITS_REVIEW.test(line)))
    return null
  const interrupted = interruptedStop(where, finish)
  if (interrupted !== null)
    return interrupted
  if (merge !== undefined)
    return stopAt(where, 'merge', merge.lines.map(line => line.replace(MERGE_PREFIX, '')).join('; '), Number(merge.pr))
  if (finish.closed)
    return null
  return stopAt(where, 'fault', report === null ? 'exited 0 without a report' : task.card.kind === 'probe' ? 'the probe report closed no task' : 'the report names no pull request')
}

interface Places extends PromptPlaces {
  number: string
}

interface Sessions {
  exit: ClaudeExit
  lastExit: ExitReason
  refused: boolean
  stopped: boolean
  halted: string | null
  current: string
  continuations: string[]
}

async function runSessions(deps: ShiftDeps, dir: string, task: ShiftTask, claude: string, places: Places, session: string, manual: boolean): Promise<Sessions> {
  const { worktree } = places
  const continuations: string[] = []
  let current = session
  let exit = await deps.run({ command: claude, cwd: worktree, sessionId: session, card: task.card.id, prompt: renderPrompt(deps.header, task, places), log: logPath(dir, places.number) })
  let lastExit: ExitReason = 'ended'
  let refused = false
  let stopped = false
  let halted: string | null = null
  while (exit.kind === 'exited') {
    const evidence = sessionEvidence(deps, task, places, current, exit.signal === null ? exit.code : null)
    lastExit = exitReason(evidence)
    refused = refused || evidence.refused
    stopped = stopped || evidence.stopped
    const handoff = deps.exists(places.report) ? deps.read(places.report) : null
    halted = boundaryWhy(task, lastExit, continuations.length, handoff, places.report)
    if (!continues(task.continue, lastExit, continuations.length, handoff ?? ''))
      break
    if (!(await continueAllowed(deps, task, lastExit, manual))) {
      halted = `${EXIT_REASON_TEXT[lastExit]}; continuing was not confirmed (--manual)`
      break
    }
    current = deps.uuid()
    continuations.push(current)
    deps.out(`${PREFIX}${task.file} ${task.id}: ${EXIT_REASON_TEXT[lastExit]}, restart ${continuations.length}/${MAX_RESTARTS} in ${worktree}`)
    const prompt = renderPrompt(deps.header, { ...task, body: continuationBody(task, places) }, places)
    exit = await deps.run({ command: claude, cwd: worktree, sessionId: current, card: task.card.id, prompt, log: logPath(dir, places.number, continuations.length) })
  }
  return { exit, lastExit, refused, stopped, halted, current, continuations }
}

type TaskBase = Pick<TaskLine, 'event' | 'file' | 'number' | 'task' | 'card' | 'branch' | 'session' | 'started'>

function finishTask(deps: ShiftDeps, task: ShiftTask, base: TaskBase, places: Places, ran: Sessions, shard: string | undefined, afterReview = false): { line: ShiftTaskLine, stop: StopRecord | null } {
  const { worktree } = places
  const { exit, lastExit, refused, stopped, halted, current, continuations } = ran
  const ended = deps.now().toISOString()
  if (exit.kind === 'unspawnable')
    return { line: { ...base, worktree, ended, exit: null, signal: null, continuations, error: exit.error }, stop: { at: 'fault', why: `claude not spawned: ${exit.error}`, worktree, session: current } }
  const report = deps.exists(places.report)
  const merge = report ? mergeFromReport(deps, task, { worktree, id: current }, places.report, { shard, refused, stopped, afterReview }) : undefined
  const journal = path.join(deps.handoffDir, GHOST_JOURNAL)
  const closed = deps.exists(journal) && closedTasks(deps.read(journal)).has(task.id)
  const line = { ...base, worktree, ended, exit: exit.code, signal: exit.signal, report, continuations, lastExit, ...heldBy({ refused, stopped }), ...(merge === undefined ? {} : { merge: merge.lines, pr: Number(merge.pr) }) }
  return { line, stop: stopAfter(task, { worktree, session: current }, { reason: lastExit, halted, exit, report: report ? deps.read(places.report) : null, merge, closed }) }
}

function startedTask(deps: ShiftDeps, task: ShiftTask, session: string): TaskBase {
  return { event: 'task', file: task.file, number: task.number, task: task.id, card: task.card, branch: task.branch, session, started: deps.now().toISOString() }
}

function startDeps(deps: ShiftDeps, dir: string, session: string, parking: string | undefined): TaskStartDeps {
  return { cwd: deps.cwd, git: deps.git, install: deps.install, exists: deps.exists, append: deps.append, now: deps.now, session, shift: dir, handoffDir: deps.handoffDir, readJournal: deps.readJournal, ...(parking === undefined ? {} : { parking: { dir: parking, read: deps.readJournal } }) }
}

async function runTask(deps: ShiftDeps, dir: string, task: ShiftTask, claude: string, handed: HandedContract, parking: string | undefined, manual: boolean, shard: string | undefined, afterReview: boolean): Promise<{ line: ShiftTaskLine, stop: StopRecord | null }> {
  const session = deps.uuid()
  const base = startedTask(deps, task, session)
  const start = runTaskStart([task.branch, '--card', task.card.line], startDeps(deps, dir, session, parking), handed)
  if (start.exitCode !== 0 || start.worktree === undefined) {
    return { line: { ...base, worktree: null, ended: deps.now().toISOString(), exit: null, signal: null, refused: start.stderr.join(' ') }, stop: null }
  }
  const places = { worktree: start.worktree, report: reportPath(dir, task.number), number: task.number }
  return finishTask(deps, task, base, places, await runSessions(deps, dir, task, claude, places, session, manual), shard, afterReview)
}

const LADDER_TURNS = 4
const NO_PNPM_RUNNER = 'no pnpm runner is wired into this shift'
const PNPM_OUTPUT_LIMIT = 64 * 1024 * 1024

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

function readIfThere(deps: ShiftDeps, file: string): string | null {
  return deps.exists(file) ? deps.read(file) : null
}

function briefFacts(deps: ShiftDeps, task: ShiftTask): LadderFacts {
  const brief = briefPathOf(deps.handoffDir, task.card)
  return { journal: readIfThere(deps, path.join(deps.handoffDir, GHOST_JOURNAL)), brief: readIfThere(deps, brief) }
}

function treeProblem(deps: ShiftDeps, tree: string, step: LadderStep['kind']): string | null {
  if (!deps.exists(tree))
    return `the tree ${tree} does not exist`
  if (step === 'review')
    return null
  try {
    const changed = deps.git(tree, ['status', '--porcelain']).split('\n').filter(line => line !== '').length
    return changed === 0 ? null : `the tree ${tree} has ${changed} changed paths`
  }
  catch (error) {
    return `the tree ${tree} cannot be read: ${firstLine(error instanceof Error ? error.message : String(error))}`
  }
}

function runPnpm(deps: ShiftDeps, args: string[], input?: string): PnpmResult | null {
  if (deps.pnpm === undefined)
    return null
  try {
    return deps.pnpm(deps.cwd, args, input)
  }
  catch (error) {
    return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

function launchTasksFile(deps: ShiftDeps, task: ShiftTask, brief: string): { file: string } | { problem: string } {
  const file = tasksFilePathOf(deps.handoffDir, task.card)
  let repo: string
  try {
    repo = deps.git(deps.cwd, ['rev-parse', '--show-toplevel']).trim()
  }
  catch (error) {
    return { problem: `not inside a git repository: ${firstLine(error instanceof Error ? error.message : String(error))}` }
  }
  const text = tasksFileText(task.card, { repo, handoffDir: deps.handoffDir, brief })
  if (deps.exists(file) && deps.read(file) !== text)
    return { problem: `${file} exists and holds another tasks file; nothing launched` }
  if (!deps.exists(file))
    deps.append(file, text)
  return { file }
}

async function runLadder(deps: ShiftDeps, dir: string, task: ShiftTask, claude: string, handed: HandedContract, parking: string, manual: boolean, shard: string | undefined): Promise<{ line: ShiftTaskLine, stop: StopRecord | null }> {
  const { card } = task
  const brief = briefPathOf(deps.handoffDir, card)
  const base = startedTask(deps, task, deps.uuid())
  const steps: string[] = []
  let worktree: string | undefined
  const result = (stop: StopRecord | null, extra: Partial<ShiftTaskLine> = {}): { line: ShiftTaskLine, stop: StopRecord | null } => ({
    line: { ...base, worktree: worktree ?? null, ended: deps.now().toISOString(), exit: stop?.at === 'fault' ? 1 : 0, signal: null, steps, ...extra },
    stop,
  })
  const stopped = (kind: Stop['at'], why: string, session: string | null = null): { line: ShiftTaskLine, stop: StopRecord | null } => result(stopAt({ worktree: worktree ?? null, session }, kind, why))
  for (let turn = 0; turn < LADDER_TURNS; turn += 1) {
    const facts = briefFacts(deps, task)
    const step = ladderStep(facts, card)
    worktree = startedTree(facts.journal ?? '', card)?.worktree
    if (step.kind === steps.at(-1))
      return stopped('fault', `the ${step.kind} step did not advance the card`)
    steps.push(step.kind)
    if (step.kind === 'running') {
      deps.out(`${PREFIX}${task.file} ${task.id}: ghost running`)
      return result(null)
    }
    if (step.kind === 'fault')
      return stopped('fault', step.why)
    if (worktree === undefined) {
      if (step.kind !== 'brief')
        return stopped('fault', `card #${card.id} has no task:start line in ${path.join(deps.handoffDir, GHOST_JOURNAL)}, so the ${step.kind} step has no tree`)
      const start = runTaskStart([task.branch, '--card', card.line], startDeps(deps, dir, base.session, parking), handed)
      if (start.exitCode !== 0 || start.worktree === undefined)
        return result(null, { refused: start.stderr.join(' '), exit: null })
      worktree = start.worktree
    }
    else {
      const problem = treeProblem(deps, worktree, step.kind)
      if (problem !== null)
        return stopped('fault', problem)
    }
    if (step.kind === 'launch') {
      const written = launchTasksFile(deps, task, brief)
      if ('problem' in written)
        return stopped('fault', written.problem)
      const launched = runPnpm(deps, ['ghosts:launch', '--tasks', written.file], 'yes\n')
      if (launched === null)
        return stopped('fault', NO_PNPM_RUNNER)
      if (launched.code === 0)
        continue
      const after = ladderStep(briefFacts(deps, task), card)
      return stopped('fault', after.kind === 'fault' ? after.why : firstLine(launched.stderr) || `ghosts:launch exit ${launched.code}`)
    }
    const session = deps.uuid()
    const label = step.kind === 'brief' ? `${task.number}-brief` : task.number
    const places = { worktree, report: reportPath(dir, label), number: label }
    const body = step.kind === 'brief' ? briefBody(card, brief) : reviewBody(card, brief, reviewOf(task.touches))
    const ran = await runSessions(deps, dir, { ...task, body: `${body}\n\n${task.body}` }, claude, places, session, manual)
    if (step.kind === 'review') {
      const finished = finishTask(deps, task, { ...base, session }, places, ran, shard)
      return { line: { ...finished.line, steps }, stop: finished.stop }
    }
    if (ran.exit.kind === 'unspawnable')
      return stopped('fault', `claude not spawned: ${ran.exit.error}`, ran.current)
    const where = { worktree, session: ran.current }
    const interrupted = askedStop(where, { reason: ran.lastExit, report: deps.exists(places.report) ? deps.read(places.report) : null }) ?? interruptedStop(where, { reason: ran.lastExit, halted: ran.halted, exit: ran.exit })
    if (interrupted !== null)
      return result(interrupted)
    if (!deps.exists(brief))
      return stopped('fault', `the brief session wrote no brief at ${brief}`, ran.current)
    const approved = runPnpm(deps, ['ghosts:hash', brief, '--by', 'morse', '--card', String(card.id), '--parking', parking])
    if (approved === null)
      return stopped('fault', NO_PNPM_RUNNER, ran.current)
    if (approved.code !== 0)
      return stopped('hash', `${LADDER_REASON}: ${firstLine(approved.stderr) || `ghosts:hash exit ${approved.code}`}`, ran.current)
  }
  return stopped('fault', `the ladder of card #${card.id} did not settle in ${LADDER_TURNS} steps`)
}

function startContract(task: ShiftTask, expected: string): Pick<Signal, 'CONTRACT' | 'EXPECT'> {
  return {
    CONTRACT: `${cardTerms(task.card)} · touches ${task.touches.join(', ')} · law not recorded in the task file`,
    EXPECT: expected,
  }
}

function startBlock(task: ShiftTask, handed: Pick<Signal, 'CONTRACT' | 'EXPECT'>, style: SignalStyle): string[] {
  return renderSignal(`shift ${task.file} #${task.id} ${task.card.name}`, {
    CONTRACT: handed.CONTRACT,
    EXPECT: handed.EXPECT,
    ACTION: `task:start ${task.branch} #${task.id}, then a headless claude session in its tree`,
    RESULT: `— running; the outcome line ${PREFIX}${task.file} ${task.id}: … follows`,
  }, style)
}

function outcome(line: ShiftTaskLine): string {
  if (line.refused !== undefined)
    return `not started: ${line.refused}`
  if (line.error !== undefined)
    return `not spawned: ${line.error}`
  if (line.signal !== null)
    return `signal ${line.signal}`
  if (line.steps !== undefined)
    return `ladder ${line.steps.join(' → ')}${line.exit === 0 ? '' : `, exit ${line.exit}`}`
  const exit = exitedWithoutReport(line) ? `exit ${line.exit}, no report` : `exit ${line.exit}`
  const restarts = line.continuations?.length ?? 0
  return restarts === 0 ? exit : `${exit}, ${restarts} ${restarts === 1 ? 'restart' : 'restarts'}`
}

interface Chain {
  waitMs: number
  limitMs: number
  cards: number
  started: number
}

type ReviewEnd = 'merge-timeout' | 'red-check' | 'pr-closed' | 'time-limit'
type ChainEnd = ReviewEnd | 'no-eligible' | 'card-budget' | 'eddies-budget' | 'question' | 'guard-refusal' | `stop-${Stop['at']}`
type PrWatch = { state: 'red' | 'closed' | 'merged' } | { state: 'open', head: string } | { error: string }

function chainLine(deps: ShiftDeps, dir: string, fields: Record<string, unknown>): void {
  deps.append(path.join(deps.handoffDir, GHOST_JOURNAL), `${JSON.stringify({ event: 'chain', shift: dir, ...fields, ts: deps.now().toISOString() })}\n`)
  deps.out(`${PREFIX}chain: ${Object.entries(fields).map(([key, value]) => `${key} ${String(value)}`).join(' · ')}`)
}

function isFailure(stop: StopRecord | null): stop is StopRecord & { failed: true } {
  return stop?.failed === true
}

function failsTheCard(line: ShiftTaskLine, stop: StopRecord): boolean {
  return stop.at === FAILED_AT && line.heldBy === undefined && stop.why !== EXIT_REASON_TEXT['guard-refusal'] && stop.why !== EXIT_REASON_TEXT['eddies-stop']
}

function lastOutputLine(deps: ShiftDeps, dir: string, line: ShiftTaskLine): string | undefined {
  const log = logPath(dir, line.number, line.continuations?.length ?? 0)
  const text = readIfThere(deps, log)
  return text?.split('\n').map(row => row.trim()).filter(row => row !== '').at(-1)
}

function failedStop(deps: ShiftDeps, dir: string, ran: { line: ShiftTaskLine, stop: StopRecord | null }): StopRecord | null {
  if (ran.stop === null || !failsTheCard(ran.line, ran.stop))
    return ran.stop
  const last = lastOutputLine(deps, dir, ran.line)
  return { ...ran.stop, failed: true, ...(last === undefined ? {} : { last }) }
}

function outcomeOf(task: ShiftTask, line: ShiftTaskLine, stop: StopRecord | null): Outcome {
  const pr = line.pr
  const card = `#${task.id} ${task.card.name}`
  if (line.refused !== undefined)
    return { card, result: 'stop not-started', reason: line.refused, pr }
  if (stop === null)
    return { card, result: 'done', reason: '—', pr }
  if (isFailure(stop))
    return { card, result: 'failed', reason: stop.last === undefined ? stop.why : `${stop.why} · ${stop.last}`, pr }
  return { card, result: `stop ${stop.at}`, reason: stop.why, pr }
}

function writeOutcomes(deps: ShiftDeps, dir: string, outcomes: Outcome[], parking: string | undefined, taken: ReadonlySet<string>): void {
  const skipped = parking === undefined ? [] : skippedOutcomes(readParking(deps, parking).choice.left, taken)
  const file = outcomesPath(dir)
  const all = [...outcomes, ...skipped]
  deps.append(file, outcomesTable(all))
  const failed = all.filter(outcome => outcome.result === 'failed').length
  deps.out(`${PREFIX}outcomes: ${failed} failed, ${skipped.length} skipped; ${file}`)
  deps.notify?.('shift over', `${all.length} cards · ${failed} failed · ${skipped.length} skipped — ${file}`)
}

function heldEnd(line: ShiftTaskLine): ChainEnd | undefined {
  return line.heldBy === undefined ? undefined : line.heldBy === 'guard-refusal' ? 'guard-refusal' : 'eddies-budget'
}

function chainEnd(stop: StopRecord): ChainEnd {
  if (stop.at === 'question')
    return 'question'
  if (stop.at === 'fault' && stop.why === EXIT_REASON_TEXT['guard-refusal'])
    return 'guard-refusal'
  return stop.at === 'fault' && stop.why === EXIT_REASON_TEXT['eddies-stop'] ? 'eddies-budget' : `stop-${stop.at}`
}

function watchPr(deps: ShiftDeps, number: number): PrWatch {
  try {
    const view = JSON.parse(deps.gh(['pr', 'view', String(number), '-R', REPO, '--json', 'headRefName,headRefOid,state'])) as { headRefName: string, headRefOid: string, state?: string }
    if (view.state === 'CLOSED')
      return { state: 'closed' }
    if (view.state === 'MERGED')
      return { state: 'merged' }
    const red = prDetails(deps.gh, REPO, { number, headRefName: view.headRefName, headRefOid: view.headRefOid, state: 'OPEN', mergedAt: null, mergeCommit: null }).ci.state === 'red'
    return red ? { state: 'red' } : { state: 'open', head: view.headRefOid }
  }
  catch (error) {
    return { error: (error instanceof Error ? error.message : String(error)).split('\n')[0]! }
  }
}

interface Review extends InReview {
  line: ShiftTaskLine
  outcome: Outcome
  since: number
  decided: boolean
  ghError?: string
}

const NO_PASS_AT_HEAD = '; no review verdict pass at its head, so the chain never armed it'

function waitWhy(result: ReviewEnd, review: Review, chain: Chain): string {
  const { pr, ghError } = review
  if (result === 'red-check')
    return `PR #${pr} required check turned red while waiting for the merge`
  if (result === 'pr-closed')
    return `PR #${pr} was closed without a merge`
  const within = result === 'time-limit' ? 'the chain time limit' : `${chain.waitMs / MINUTE_MS} minutes`
  const unreviewed = !review.decided && review.task.card.decision === 'auto' ? NO_PASS_AT_HEAD : ''
  return `PR #${pr} not merged within ${within}${unreviewed}${ghError === undefined ? '' : `; gh could not read it: ${ghError}`}`
}

function decideAfterReview(deps: ShiftDeps, dir: string, review: Review, head: string, shard: string | undefined): void {
  const verdict = latestPrReview(readIfThere(deps, path.join(deps.handoffDir, GHOST_JOURNAL)), review.task.id, review.pr)
  if (verdict === undefined || !passedAt(verdict, head))
    return
  const report = reportPath(dir, review.line.number)
  const lines = mergeLines(deps, review.task, String(review.pr), readIfThere(deps, report) ?? '', { shard, refused: false, stopped: false, afterReview: false, reviewed: verdict.commit })
  deps.append(report, `\n${lines.join('\n')}\n`)
  for (const line of lines)
    deps.out(line)
  review.decided = true
  chainLine(deps, dir, { step: 'reviewed', task: review.task.id, pr: review.pr, armed: lines.some(line => MERGE_ARMED.test(line)) })
}

function endReviews(deps: ShiftDeps, dir: string, chain: Chain, reviews: Review[], reason: ChainEnd, culprit?: Review): ChainEnd {
  for (const review of reviews) {
    const own = review === culprit || reason === 'time-limit'
    const why = own ? waitWhy(reason as ReviewEnd, review, chain) : `PR #${review.pr} ${review.decided ? 'not merged' : 'had no review verdict pass at its head'} when the chain ended on ${reason}`
    recordStop(deps, dir, review.task.id, stopAt({ worktree: review.line.worktree, session: review.line.session }, 'merge', why, review.pr))
    Object.assign(review.outcome, { result: `stop ${own ? reason : 'merge'}`, reason: why })
  }
  reviews.length = 0
  return reason
}

function pollReviews(deps: ShiftDeps, dir: string, chain: Chain, reviews: Review[], shard: string | undefined): ChainEnd | undefined {
  for (const review of reviews) {
    const watched = watchPr(deps, review.pr)
    if ('error' in watched) {
      review.ghError = watched.error
      continue
    }
    review.ghError = undefined
    if (watched.state === 'red')
      return endReviews(deps, dir, chain, reviews, 'red-check', review)
    if (watched.state === 'closed')
      return endReviews(deps, dir, chain, reviews, 'pr-closed', review)
    if (watched.state === 'open' && !review.decided)
      decideAfterReview(deps, dir, review, watched.head, shard)
  }
  const ghostJournal = path.join(deps.handoffDir, GHOST_JOURNAL)
  sweepMerges(deps, ghostJournal, dir)
  const merged = mergedTasks(readIfThere(deps, ghostJournal))
  for (const review of reviews.filter(open => merged.has(open.task.id))) {
    reviews.splice(reviews.indexOf(review), 1)
    chainLine(deps, dir, { step: 'merged', task: review.task.id, pr: review.pr })
  }
  const now = deps.now().getTime()
  const late = reviews.find(review => now - review.since >= chain.waitMs)
  return late === undefined ? undefined : endReviews(deps, dir, chain, reviews, 'merge-timeout', late)
}

async function advance(deps: ShiftDeps, dir: string, parking: string, chain: Chain, reviews: Review[], taken: ReadonlySet<string>, shard: string | undefined, ending: ChainEnd | undefined): Promise<ShiftTask | ChainEnd> {
  for (;;) {
    const ended = pollReviews(deps, dir, chain, reviews, shard)
    if (ended !== undefined)
      return ended
    if (deps.now().getTime() - chain.started >= chain.limitMs)
      return endReviews(deps, dir, chain, reviews, 'time-limit')
    const stopsTaking = ending ?? (taken.size >= chain.cards ? 'card-budget' : undefined)
    if (stopsTaking === undefined) {
      const { next } = nextInPipeline(readParking(deps, parking).choice.chosen, taken, reviews)
      if (next !== undefined) {
        chainLine(deps, dir, { step: 'next', task: next.id, after: [...taken].at(-1) })
        return next
      }
    }
    if (reviews.length === 0)
      return stopsTaking ?? 'no-eligible'
    await deps.sleep!(CHAIN_POLL_MS)
  }
}

const ENDS_OF_THE_CARD: readonly ChainEnd[] = ['guard-refusal', 'eddies-budget']

function cardEnding(deps: ShiftDeps, dir: string, task: ShiftTask, ran: { line: ShiftTaskLine, stop: StopRecord | null }): ChainEnd | undefined {
  const { line, stop } = ran
  if (stop !== null && stop.at !== 'merge') {
    recordStop(deps, dir, task.id, stop)
    return isFailure(stop) ? undefined : heldEnd(line) ?? chainEnd(stop)
  }
  if (line.heldBy === 'guard-refusal') {
    recordStop(deps, dir, task.id, stopAt({ worktree: line.worktree, session: line.session }, 'fault', EXIT_REASON_TEXT['guard-refusal'], line.pr))
    return 'guard-refusal'
  }
  return line.heldBy === 'eddies-stop' ? 'eddies-budget' : undefined
}

async function chainStep(deps: ShiftDeps, dir: string, parking: string, chain: Chain, task: ShiftTask, ran: { line: ShiftTaskLine, stop: StopRecord | null }, taken: ReadonlySet<string>, pipeline: { reviews: Review[], outcome: Outcome, shard: string | undefined }): Promise<ShiftTask | ChainEnd> {
  const { line } = ran
  const ending = cardEnding(deps, dir, task, ran)
  if (ending !== undefined && ENDS_OF_THE_CARD.includes(ending) && pipeline.outcome.result === 'done')
    Object.assign(pipeline.outcome, { result: `stop ${ending}`, reason: latestStops(readIfThere(deps, path.join(deps.handoffDir, GHOST_JOURNAL))).get(task.id)?.why ?? ending })
  if (ending === undefined && line.pr !== undefined) {
    chainLine(deps, dir, { step: 'wait', task: task.id, pr: line.pr, review: reviewOf(task.touches).depth })
    pipeline.reviews.push({ task, pr: line.pr, line, outcome: pipeline.outcome, since: deps.now().getTime(), decided: !line.merge?.some(merge => AWAITS_REVIEW.test(merge)) })
  }
  return advance(deps, dir, parking, chain, pipeline.reviews, taken, pipeline.shard, ending)
}

export async function runShift(argv: string[], deps: ShiftDeps): Promise<number> {
  if (argv.includes('--help')) {
    deps.out(USAGE)
    return 0
  }
  const check = argv.includes('--check')
  if (deps.cloud === true && !check)
    return refuse(deps, [`${CLOUD_VARIABLE}=1 routes card bodies to cloud sessions the window launches; the shift spawns no local session`])
  const queue = argv.includes('--queue')
  const manual = argv.includes('--manual')
  const parkingAt = argv.indexOf('--parking')
  const parkingArg = parkingAt === -1 ? undefined : argv[parkingAt + 1]
  const slotAt = argv.indexOf('--slot')
  const shard = slotAt === -1 ? undefined : argv[slotAt + 1]
  const chained = argv.includes('--chain')
  const chainFlags = CHAIN_VALUED.map(flag => argv.indexOf(flag))
  const chainValues = CHAIN_VALUED.map((flag, index) => chainFlags[index] === -1 ? undefined : argv[chainFlags[index]! + 1])
  const valuedAts = [parkingAt, slotAt, ...chainFlags].filter(at => at !== -1)
  const valued = valuedAts.flatMap(at => [at, at + 1])
  const rest = argv.filter((arg, index) => arg !== '--check' && arg !== '--queue' && arg !== '--manual' && arg !== '--chain' && !valued.includes(index))
  const chainNumbers = chainValues.map(value => value === undefined ? undefined : Number(value))
  if (rest.length !== 1 || rest[0]!.startsWith('-') || valuedAts.some(at => argv[at + 1] === undefined || argv[at + 1]!.startsWith('-')) || chainNumbers.some(value => value !== undefined && !(Number.isInteger(value) && value > 0)))
    return refuse(deps, [USAGE.split('\n')[0]!])
  if (chained && (parkingArg === undefined || manual))
    return refuse(deps, ['--chain needs --parking and cannot be used with --manual; nothing started'])
  if (chained && !check && (deps.sleep === undefined))
    return refuse(deps, ['no sleep is wired into this shift, so --chain cannot wait for a merge; nothing started'])
  const dir = path.resolve(deps.cwd, rest[0]!)
  const ghostJournal = path.join(deps.handoffDir, GHOST_JOURNAL)
  if (shard !== undefined) {
    const refused = slotRefusal(deps.cwd) ?? shardRefusal(readIfThere(deps, ghostJournal), shard, dir)
    if (refused !== null)
      return refuse(deps, [`--slot: ${refused}; nothing started`])
  }
  const journal = path.join(dir, SHIFT_JOURNAL)
  if (deps.exists(journal))
    return refuse(deps, [`${journal} exists: this shift already ran; start a new one in a new directory`])
  const parking = parkingArg === undefined ? undefined : path.resolve(deps.cwd, parkingArg)
  if (parking !== undefined && !check)
    sweepMerges(deps, ghostJournal, dir)
  const read = parking === undefined ? { ...readTasks(deps, dir), choice: undefined } : readParking(deps, parking)
  const { errors } = read
  if (errors.length > 0)
    return refuse(deps, errors)
  if (read.choice !== undefined) {
    for (const line of choiceLines(read.choice, queue))
      deps.out(line)
    if (check && read.choice.left.some(card => card.reason.startsWith('depends ')))
      deps.out(MERGE_HINT)
  }
  const tasks = read.choice?.chosen ?? ('tasks' in read ? read.tasks : [])
  if (tasks.length === 0)
    return refuse(deps, [parking === undefined ? `no NN.md task file in ${dir}` : `no card in ${parking} is for the shift now`])
  const conflicts = taskConflicts(tasks)
  if (conflicts.length > 0)
    return refuse(deps, ['tasks of one shift declare overlapping touches; nothing started', ...conflicts])
  warnOpenPrs(deps, tasks)
  if (check) {
    deps.out(`${PREFIX}check passed: ${tasks.map(task => task.file).join(', ')}`)
    return 0
  }
  const claude = deps.claude?.trim() ?? ''
  if (claude === '')
    return refuse(deps, [`${CLAUDE_VARIABLE} is not set; it names the claude command (see --help)`])
  const parked = read.choice === undefined ? {} : { parking, left: read.choice.left }
  if (shard !== undefined) {
    deps.append(ghostJournal, usedLine(shard, dir, deps.now()))
    deps.out(`${PREFIX}shard ${shard} used by this run: an owner pull request the guards and the checks pass is armed`)
  }
  if (read.choice !== undefined)
    deps.append(path.join(dir, QUEUE_FILE), queueText(read.choice.left))
  deps.append(journal, `${JSON.stringify({ event: 'start', at: deps.now().toISOString(), tasks: tasks.map(task => task.file), ...parked })}\n`)
  deps.append(journal, autopilotLine(deps, dir, manual))
  let clean = true
  const [waitMinutes = CHAIN_WAIT_MINUTES, limitMinutes = CHAIN_LIMIT_MINUTES, cards = CHAIN_CARDS] = chainNumbers
  const chain = chained ? { waitMs: waitMinutes * MINUTE_MS, limitMs: limitMinutes * MINUTE_MS, cards, started: deps.now().getTime() } : undefined
  const releaseHangup = chain === undefined ? undefined : deps.holdHangup?.()
  const sessionDeps: ShiftDeps = chain === undefined ? deps : { ...deps, run: run => deps.run({ ...run, detached: true }) }
  const pending = chain === undefined ? [...tasks] : tasks.slice(0, 1)
  const taken = new Set<string>()
  const outcomes: Outcome[] = []
  const reviews: Review[] = []
  try {
    while (pending.length > 0) {
      const task = pending.shift()!
      taken.add(task.id)
      const forecast = cheapForecastOf(path.dirname(dir), path.join(deps.handoffDir, GHOST_JOURNAL), cheapClass(task.card), deps.projectsDir)
      const handed = { ...startContract(task, formatCheapExpect(forecast)), forecast }
      if (!(await takeAllowed(deps, task, manual))) {
        deps.out(`${PREFIX}${task.file} ${task.id}: not taken, not confirmed (--manual)`)
        continue
      }
      for (const line of startBlock(task, handed, deps.style ?? PLAIN_STYLE))
        deps.out(line)
      const finished = parking !== undefined && isLadder(task.card) ? await runLadder(sessionDeps, dir, task, claude, handed, parking, manual, shard) : await runTask(sessionDeps, dir, task, claude, handed, parking, manual, shard, chain !== undefined && reviewOf(task.touches).depth !== 'none')
      const ran = { line: finished.line, stop: failedStop(deps, dir, finished) }
      deps.append(journal, `${JSON.stringify(ran.line)}\n`)
      deps.out(`${PREFIX}${task.file} ${task.id}: ${outcome(ran.line)}`)
      clean &&= succeeded(ran.line)
      outcomes.push(outcomeOf(task, ran.line, ran.stop))
      if (isFailure(ran.stop))
        deps.notify?.(`shift: #${task.id} failed`, `${ran.stop.why} — ${outcomesPath(dir)}`)
      if (chain === undefined) {
        if (ran.stop !== null)
          recordStop(deps, dir, task.id, ran.stop)
        continue
      }
      const next = await chainStep(deps, dir, parking!, chain, task, ran, taken, { reviews, outcome: outcomes.at(-1)!, shard })
      if (typeof next === 'string') {
        chainLine(deps, dir, { step: 'end', reason: next, cards: taken.size })
        deps.out(`${PREFIX}chain ended: ${next}`)
        break
      }
      pending.push(next)
    }
  }
  finally {
    releaseHangup?.()
  }
  if (parking !== undefined)
    sweepMerges(deps, ghostJournal, dir)
  writeOutcomes(deps, dir, outcomes, parking, taken)
  deps.out(`${PREFIX}shift over; pnpm shift:report ${dir}`)
  return clean ? 0 : 1
}

async function askOnTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/i.test((await terminal.question(`${PREFIX}${question} [y/N] `)).trim())
  }
  finally {
    terminal.close()
  }
}

export function runPnpmCommand(cwd: string, args: string[], input?: string): PnpmResult {
  const result = spawnSync('pnpm', args, { cwd, input, encoding: 'utf8', maxBuffer: PNPM_OUTPUT_LIMIT })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error === undefined ? result.stderr ?? '' : result.error.message }
}

type Stream = Pick<NodeJS.WriteStream, 'on' | 'off'>

export function holdThroughHangup(proc: Pick<NodeJS.Process, 'on' | 'off'> & { stdout?: Stream, stderr?: Stream } = process): () => void {
  const ignore = (): void => {}
  const streams = [proc.stdout, proc.stderr].filter(stream => stream !== undefined)
  proc.on('SIGHUP', ignore)
  for (const stream of streams)
    stream.on('error', ignore)
  return () => {
    proc.off('SIGHUP', ignore)
    for (const stream of streams)
      stream.off('error', ignore)
  }
}

function writeQuietly(write: (line: string) => void, line: string): void {
  try {
    write(line)
  }
  catch {
  }
}

function realDeps(): ShiftDeps {
  return {
    cwd: process.cwd(),
    claude: process.env[CLAUDE_VARIABLE],
    header: readFileSync(path.join(import.meta.dirname, 'header.md'), 'utf8'),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    readJournal: readJournalFile,
    projectsDir: claudeProjectsDir(),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    install: pnpmInstall,
    gh: execGh,
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    uuid: randomUUID,
    confirm: process.stdin.isTTY ? askOnTerminal : undefined,
    pnpm: runPnpmCommand,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    holdHangup: holdThroughHangup,
    notify: osascriptNotify(),
    run: runClaude,
    out: line => writeQuietly(console.log, line),
    err: line => writeQuietly(console.error, line),
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
    cloud: cloudOn(process.env),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runShift(process.argv.slice(2), realDeps())
