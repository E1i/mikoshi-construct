import type { Paint, Signal, SignalStyle } from '../../src/ui/signal.js'
import type { AttemptView, Summary, TaskView } from './derive.js'
import type { ContextLimits } from './eddies.js'
import type { ForecastOf } from './forecast.js'
import type { PrDetails } from './gh.js'
import type { ModelMismatch } from './roles.js'
import type { Age, NextOf, Row } from './row.js'
import type { Tree, Unregistered } from './tree.js'
import { stripVTControlCharacters } from 'node:util'
import { renderSignal } from '../../src/ui/signal.js'
import { FINISHED_SHOWN_HOURS, finishedAt, latestStage, reportOf, stageText } from './derive.js'
import { budgetText, contextPercent, eddiesOf, eddiesText } from './eddies.js'
import { FRAME_FILE } from './frame.js'
import { REQUIRED_CHECK } from './gh.js'
import { mismatchText } from './roles.js'
import { ageSince, rowOf } from './row.js'
import { STALE_HOURS, staleAge } from './stale.js'
import { toneOf } from './tone.js'
import { treeText, unregisteredText } from './tree.js'
import { VERIFICATION_WORDS } from './verification.js'

export interface BoardView {
  tasks: TaskView[]
  shown: TaskView[]
  summary: Summary
  windowMismatches: ModelMismatch[]
  limits: ContextLimits | undefined
  miko: { session: string, context: number | undefined } | undefined
  contextWarnPercent: number | undefined
  staleHours: number
  edges: string[] | undefined
  details: Map<string, PrDetails>
  trees: Map<string, Tree | undefined>
  unregistered: Unregistered[]
  nextOf: NextOf
  forecastOf: ForecastOf
  now: Date
  style: SignalStyle
}

const COLUMNS = ['TASK', 'PATH', 'STAGE', 'AGE', 'NEXT', 'WINDOW', 'TREE', 'EDDIES', 'EXPECT', 'ACTUAL'] as const
const ROW_ORDER = ['blocked', 'stale', 'waiting', 'running'] as const
const BORDERS = {
  top: ['┌', '┬', '┐'],
  under: ['├', '┼', '┤'],
  bottom: ['└', '┴', '┘'],
} as const
export const NOTHING_OPEN = ['nothing running — no tasks, no live windows.', 'Start one: open a Miko window and describe the task, or /plan <task>.']

const RULE = '─'
const SEPARATOR = '│'

const ROW_DEFINITION = '# columns: TASK = the live attempt; PATH = ladder or cheap; STAGE = the latest stage recorded done; AGE = the time since it, "clock skew" when that time is ahead of now; NEXT (derived) = what the task waits for and from whom, from the stage, the PR\'s CI and architecture/owner-merges.md, led by stale <age> when the task is stale; EDDIES = ctx <percent> of its live window, stop <n> and warn <n> of its budget lines, — with none; EXPECT = the journal event:task expected, as ghosts:launch printed it, expect not recorded in the journal when it has none (the cheap path, a ladder still running); ACTUAL = the journal event:task actual tokens and minutes beside it, actual not recorded in the journal with none'

export const DEFINITIONS = [
  `# board: read-only, except that each --every frame is written to <handoff dir>/${FRAME_FILE}; a stage is a recorded fact, — when it did not happen, or UNKNOWN naming the record that is missing`,
  `# stages: brief = brief file mtime · approved = <brief>.approved-sha256 mtime · ghost = journal event:task ts · review = last journal event:review · ready = the check "${REQUIRED_CHECK}" green on the PR\'s current head (gh), at its completedAt · merged = journal event:merge, else gh mergedAt · hand-ladder = the updated time of the status.md policy row hand-ladder-<id>, while it runs`,
  '# hand-ladder = the owner decided the ladder runs by hand in a fresh session, and the window wrote the status.md policy row hand-ladder-<id>; it runs until a journal event:task, event:review or event:merge of the task is later than that row\'s updated time (a row whose time does not parse runs until the task is merged); while it runs it is the live attempt\'s last stage, the attempt is running and NEXT reads the ladder\'s run; once it ends the card keeps it as a hand-ladder fact',
  '# ready is derived from CI, never from the journal: — while CI on the current head is pending, red or has not reported; a push makes a new head, and the task is not ready until CI on that head is green; a journal ready field is not read',
  '# cheap path (a journal event:path line with path cheap): started → ready → pr → merged; started and pr from that line, ready from CI on that PR\'s head, merged = journal event:merge, else gh mergedAt of that PR number; no brief, approved, ghost or review stages',
  '# report = a cheap-path event:path line with a report and no pr: started → reported (its ts); the task ends in that file, not a PR, and NEXT reads report: <path>',
  `# verification (cheap path) = the one word the event:path line records for how the result was known: ${VERIFICATION_WORDS.join(', ')}; a fact, not a stage, so it is not in --json\'s UNKNOWN tally`,
  '# — = did not happen: not merged while the last review verdict is changes, no PR for the branch, a PR not merged, a ghost still running',
  '# UNKNOWN = a record could exist and does not; the missing record is named; --json tallies them by event under unknown, over every attempt but the superseded',
  '# task (derived) = the attempts whose tasks-file entries name one brief file; the latest attempt is live, the others are history',
  '# latest (derived) = ordered by the status.md start of ghost-<id>, else by the mtime of the newest tasks file naming it',
  '# status.md times carry no zone; they are read as this machine\'s local time',
  '# merged = a journal event:merge or a gh mergedAt exists; reported = the event:path line names a report and no pr',
  '# running = not merged, and its status.md row ghost-<id> has state writing, reviewing or reading; on the cheap path, not merged, not reported and not ready; or a status.md policy row hand-ladder-<id> whose ladder has not ended',
  '# blocked = not merged, not running, and the journal records exit != 0, a ladder outcome other than "done", or a last review verdict "changes"',
  '# waiting = not merged, not running, not blocked, and a journal event:task exists (ladder finished, nothing after it recorded); on the cheap path, not merged and ready',
  `# summary = over live attempts only: MIKO context, open = running + waiting + blocked, stale, windows live, merged ${FINISHED_SHOWN_HOURS}h = merged or reported within the last ${FINISHED_SHOWN_HOURS}h; --json keeps longest = now minus the status.md start (on the cheap path, the event:path started)`,
  `# MIKO context = the context of the window that runs the board (CLAUDE_CODE_SESSION_ID): the context field of its last turn or late line in <repo>/.construct/turns.jsonl over contextLimit of .claude/eddies.json, marked (warn at <n>%) from --context-warn <percent>, else warnRatio; — with no reading, no segment outside a window`,
  `# stale = running, waiting or blocked, not superseded, and its last recorded event (the latest stage done; on the cheap path also the last turn of its window) older than --stale <hours>, ${STALE_HOURS} by default`,
  `# shown: tasks whose live attempt is running, waiting or blocked, as rows ordered blocked, stale, waiting, running and the oldest first within each; and every task merged or reported within the last ${FINISHED_SHOWN_HOURS}h, on the merged line newest first; --all shows every task`,
  '# superseded = a journal event:superseded names the attempt and the attempt that replaced it (by); a task whose live attempt is superseded is left out of the summary and the default list, and every superseded attempt out of --json\'s UNKNOWN tally; --all lists it, NEXT reads — (superseded); its card names the successor, as --json does',
  '# model-mismatch = a line of .construct/roles.jsonl, written when a subagent ran on a model outside the one its .claude/agents definition names (the parent session\'s model when it names none or inherit); a card lists its attempts\' lines from the worktree, the summary counts them and the window\'s own from this repository; with none, nothing is printed',
  '# eddies = a budget-stop or budget-warn line of .construct/eddies.jsonl, written by the Eddies hook when a session, agent or workflow run reached a threshold of .claude/eddies.json or its warnRatio share; a card lists its attempts\' lines, from the worktree and from this repository\'s journal where session_id is the session the task\'s event:path line names; EDDIES counts them',
  '# window = the session a cheap-path event:path line names (fields of all the task\'s event:path lines fold, a later line overriding an earlier one), read in <repo>/.construct/turns.jsonl: WINDOW = first 8 of the session · turn <age of its last turn, late or subagent line> | · ended when a session-end line exists | UNKNOWN (no session); — on the ladder',
  '# tree = the worktree and branch a tasks file or an event:path line names: TREE = basename · branch · dirty <lines of git status --porcelain>, gone when the path does not exist, — when none is named',
  '# cheap path, window ended: not merged, no pr on the line, no PR for the branch the start line names (gh pr list --state all, shown as pr via <branch>) and the session has a session-end line → blocked; NEXT reads "handoff, waits for a new window" when a handoff-*<id>*.md file is in the handoff dir, else "window closed, no PR"; a live or unknown window keeps it running',
  '# windows live = live cheap-path attempts that are running, waiting or blocked, whose session has no session-end line',
  '# unregistered trees = git worktree list of this repository, less the main tree and every worktree a task names; shown after the table, listed as <path> <branch|detached> dirty <n>, trees under /scratchpad/ in the session scratch group; ghosts:cleanup never removes them',
  '# edge = contour.after of the Shredder matrix a tasks file names; UNKNOWN without one',
  `# nothing open = no row running, waiting or blocked: the board prints "${NOTHING_OPEN[0]}" and how to start one instead of an empty table, and keeps the merged line under it; --json keeps its empty arrays`,
  ROW_DEFINITION,
]

export function formatMinutes(minutes: number): string {
  if (minutes < 60)
    return `${minutes}m`
  if (minutes < 24 * 60)
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(minutes / (24 * 60))}d${Math.floor((minutes % (24 * 60)) / 60)}h`
}

export function formatAge(age: Age): string {
  return age.skew ? `clock skew (${formatMinutes(age.minutes)} ahead)` : formatMinutes(age.minutes)
}

export function summaryLine(summary: Summary, miko?: string): string {
  const { running, waiting, blocked } = summary.counts
  const open = running + waiting + blocked
  const body = `open ${open}: running ${running}, waiting ${waiting}, blocked ${blocked}, stale ${summary.stale} · windows live ${summary.windowsLive} · merged ${FINISHED_SHOWN_HOURS}h: ${summary.finished}`
  return miko === undefined ? body : `${miko} · ${body}`
}

export function mikoText(view: BoardView): string | undefined {
  if (view.miko === undefined)
    return undefined
  if (view.limits === undefined)
    return 'MIKO context UNKNOWN (missing: .claude/eddies.json)'
  if (view.miko.context === undefined)
    return 'MIKO context —'
  const percent = contextPercent(view.miko.context, view.limits)
  const warnPercent = view.contextWarnPercent ?? Math.round(view.limits.warnRatio * 100)
  return percent >= warnPercent ? `MIKO context ${percent}% (warn at ${warnPercent}%)` : `MIKO context ${percent}%`
}

function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length
}

function padded(text: string, width: number): string {
  return `${text}${' '.repeat(width - visibleWidth(text))}`
}

function borderLine([left, joint, right]: readonly [string, string, string], widths: number[]): string {
  return `${left}${widths.map(width => RULE.repeat(width + 2)).join(joint)}${right}`
}

function cellLine(cells: string[], widths: number[]): string {
  return `${SEPARATOR} ${cells.map((cell, column) => padded(cell, widths[column]!)).join(` ${SEPARATOR} `)} ${SEPARATOR}`
}

export function windowText(live: AttemptView, now: Date): string {
  const { session, lastAt, ended } = live.attempt.window
  if (live.path === 'ladder')
    return '—'
  if (session === undefined)
    return 'UNKNOWN (no session)'
  if (ended)
    return `${session.slice(0, 8)} · ended`
  return lastAt === undefined ? `${session.slice(0, 8)} · no turn recorded` : `${session.slice(0, 8)} · turn ${formatAge(ageSince(lastAt, now))}`
}

interface Entry {
  row: Row
  stale: Age | undefined
  window: string
  tree: string
  eddies: string
  expect: string
  actual: string
}

export function attemptEddies(live: AttemptView): ReturnType<typeof eddiesOf> {
  const { window } = live.attempt
  return eddiesOf(live.path === 'cheap' && !window.ended ? window.context : undefined, live.attempt.budgetLines)
}

function entryOf(task: TaskView, view: BoardView): Entry {
  return {
    row: rowOf(task, view.nextOf, view.now),
    stale: staleAge(task.live, view.now, view.staleHours),
    window: windowText(task.live, view.now),
    tree: treeText(view.trees.get(task.live.attempt.id)),
    eddies: eddiesText(attemptEddies(task.live), view.limits),
    ...view.forecastOf(task.live),
  }
}

function rowCells({ row, stale, window, tree, eddies, expect, actual }: Entry, paint: Paint): string[] {
  const tone = toneOf(row)
  const next = stale === undefined ? row.next.text : `stale ${formatAge(stale)} · ${row.next.text}`
  return [row.id, row.path, paint(tone, row.stage?.name ?? '—'), row.age === undefined ? '—' : formatAge(row.age), paint(tone, next), window, tree, eddies, expect, actual]
}

function rankOf({ stale }: Entry, category: string): number {
  const rank = ROW_ORDER.indexOf((stale === undefined ? category : 'stale') as typeof ROW_ORDER[number])
  return rank === -1 ? ROW_ORDER.length : rank
}

function ordered(tasks: TaskView[], view: BoardView): Entry[] {
  return tasks
    .map(task => ({ entry: entryOf(task, view), category: task.live.category }))
    .sort((a, b) => rankOf(a.entry, a.category) - rankOf(b.entry, b.category) || (b.entry.row.age?.minutes ?? -1) - (a.entry.row.age?.minutes ?? -1))
    .map(({ entry }) => entry)
}

function tableLines(entries: Entry[], paint: Paint): string[] {
  const grid: string[][] = [[...COLUMNS], ...entries.map(entry => rowCells(entry, paint))]
  const [header, ...body] = grid
  const widths = COLUMNS.map((_, column) => Math.max(...grid.map(cells => visibleWidth(cells[column]!))))
  return [
    borderLine(BORDERS.top, widths),
    cellLine(header!, widths),
    borderLine(BORDERS.under, widths),
    ...body.map(cells => cellLine(cells, widths)),
    borderLine(BORDERS.bottom, widths),
  ]
}

function openLines(entries: Entry[], paint: Paint): string[] {
  return entries.length === 0 ? NOTHING_OPEN : tableLines(entries, paint)
}

function finishedText(task: TaskView): string {
  const { live } = task
  if (live.pr.kind === 'found')
    return `${live.attempt.id} PR #${live.pr.pr.number}`
  const report = reportOf(live.attempt.pathEvent)
  return report === undefined ? live.attempt.id : `${live.attempt.id} report: ${report}`
}

function mergedLines(finished: TaskView[], view: BoardView): string[] {
  const older = view.tasks.length > view.shown.length ? '   (older: --all)' : ''
  if (finished.length === 0)
    return older === '' ? [] : [`merged: —${older}`]
  return [`merged: ${finished.map(finishedText).join(' · ')}${older}`]
}

function mismatchSummaryLines(view: BoardView): string[] {
  const tasks = new Map(view.tasks.flatMap(task => task.attempts).map(attempt => [attempt.attempt.worktree ?? attempt.attempt.id, attempt.attempt.modelMismatches.length]))
  const inTasks = [...tasks.values()].reduce((sum, count) => sum + count, 0)
  const total = inTasks + view.windowMismatches.length
  return total === 0 ? [] : [`model-mismatch ${total}: window ${view.windowMismatches.length}, tasks ${inTasks} (a role ran on a model its definition does not name; .construct/roles.jsonl)`]
}

function unregisteredLines(view: BoardView): string[] {
  if (view.unregistered.length === 0)
    return []
  const scratch = view.unregistered.filter(tree => tree.scratch)
  const rest = view.unregistered.filter(tree => !tree.scratch)
  return [
    `unregistered trees ${view.unregistered.length}`,
    ...rest.map(tree => `  ${unregisteredText(tree)}`),
    ...(scratch.length === 0 ? [] : [`session scratch ${scratch.length}`, ...scratch.map(tree => `  ${unregisteredText(tree)}`)]),
  ]
}

export function renderBoard(view: BoardView): string[] {
  const finished = view.shown.filter(task => finishedAt(task.live) !== undefined)
  return [
    summaryLine(view.summary, mikoText(view)),
    ...mismatchSummaryLines(view),
    ...openLines(ordered(view.shown.filter(task => !finished.includes(task)), view), view.style.paint),
    ...mergedLines(finished, view),
    ...unregisteredLines(view),
  ]
}

function attemptLines(task: TaskView, details: Map<string, PrDetails>): string[] {
  const history = task.attempts.filter(view => view !== task.live).map(view => view.attempt.id)
  const lines = [`task ${task.name} (derived) live ${task.live.attempt.id} ${task.live.category}${history.length > 0 ? `, history ${history.join(', ')}` : ''}`]
  for (const view of task.attempts) {
    lines.push(`  ${view.attempt.id} ${view === task.live ? 'live' : 'history'} ${view.category}`)
    for (const line of [...view.stages, ...view.facts]) {
      const ci = line.name === 'pr' ? details.get(view.attempt.id)?.ci.text : undefined
      lines.push(`    ${line.name} ${stageText(line)}${ci === undefined ? '' : `, ci ${ci}`}`)
    }
    for (const mismatch of view.attempt.modelMismatches)
      lines.push(`    ${mismatchText(mismatch)}`)
    for (const budget of view.attempt.budgetLines)
      lines.push(`    ${budgetText(budget)}`)
  }
  return lines
}

function edgeLines(task: TaskView, edges: string[] | undefined): string[] {
  if (edges === undefined)
    return ['edge: UNKNOWN']
  const ids = new Set(task.attempts.map(view => view.attempt.id))
  const own = edges.filter(edge => edge.split(' -> ').some(id => ids.has(id)))
  return own.length > 0 ? own.map(edge => `edge: ${edge}`) : ['edge: — (the matrix records none for this task)']
}

const NOT_RECORDED_IN_JOURNAL = 'not recorded in the journal'

function contractText(live: AttemptView): string {
  const { attempt } = live
  if (live.path === 'ladder')
    return `ladder · brief ${attempt.brief ?? '—'} · law ${NOT_RECORDED_IN_JOURNAL}`
  return attempt.entryLine?.CONTRACT ?? `contract not recorded in ${attempt.journalPath}: no entry line for #${attempt.id}`
}

function actionText(live: AttemptView): string {
  const { attempt } = live
  if (live.path === 'cheap')
    return `task:start ${attempt.branch ?? '—'} #${attempt.id}: ${attempt.worktree ?? '—'}`
  if (attempt.taskEvent === undefined)
    return `ghosts:launch ${attempt.id}: no journal event:task yet`
  return `ghosts:launch ${attempt.id}: /implement ${attempt.brief ?? '—'}, session ${attempt.taskEvent.session ?? '—'}`
}

function resultText(live: AttemptView): string {
  const stage = latestStage(live)
  return stage === undefined ? '—' : `${stage.name} ${stageText(stage)}`
}

function expectText(entry: Entry, live: AttemptView): string {
  if (live.path === 'ladder')
    return entry.expect
  return live.attempt.entryLine?.EXPECT ?? `expect not recorded in ${live.attempt.journalPath}: no entry line for #${live.attempt.id}`
}

function signalOf(entry: Entry, live: AttemptView): Signal {
  return { CONTRACT: contractText(live), EXPECT: expectText(entry, live), ACTION: actionText(live), RESULT: resultText(live) }
}

export function renderCard(task: TaskView, view: BoardView): string[] {
  const entry = entryOf(task, view)
  const { row } = entry
  return [
    ...tableLines([entry], view.style.paint),
    ...attemptLines(task, view.details),
    `next ${row.next.text} (derived${row.next.why === undefined ? '' : `; ${row.next.why}`})`,
    ...edgeLines(task, view.edges),
    ...renderSignal(`board ${row.id}`, signalOf(entry, task.live), view.style, toneOf(row)),
  ]
}
