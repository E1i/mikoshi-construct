import type { Summary, TaskView } from './derive.js'
import type { BudgetLine } from './eddies.js'
import type { PrDetails } from './gh.js'
import type { ModelMismatch } from './roles.js'
import type { Age, NextOf, Row } from './row.js'
import type { Paint } from './tone.js'
import { stripVTControlCharacters } from 'node:util'
import { FINISHED_SHOWN, FINISHED_SHOWN_HOURS, isSuperseded, stageText } from './derive.js'
import { budgetSummary, budgetText } from './eddies.js'
import { FRAME_FILE } from './frame.js'
import { REQUIRED_CHECK } from './gh.js'
import { mismatchText } from './roles.js'
import { rowOf } from './row.js'
import { toneOf } from './tone.js'
import { VERIFICATION_WORDS } from './verification.js'

export interface BoardView {
  tasks: TaskView[]
  shown: TaskView[]
  summary: Summary
  windowMismatches: ModelMismatch[]
  windowBudgetLines: BudgetLine[]
  edges: string[] | undefined
  details: Map<string, PrDetails>
  nextOf: NextOf
  now: Date
  paint: Paint
}

const COLUMNS = ['TASK', 'PATH', 'STAGE', 'AGE', 'NEXT'] as const
const BORDERS = {
  top: ['┌', '┬', '┐'],
  under: ['├', '┼', '┤'],
  bottom: ['└', '┴', '┘'],
} as const
const RULE = '─'
const SEPARATOR = '│'

const ROW_DEFINITION = '# columns: TASK = the live attempt; PATH = ladder or cheap; STAGE = the latest stage recorded done; AGE = the time since it, "clock skew" when that time is ahead of now; NEXT (derived) = what the task waits for and from whom, from the stage, the PR\'s CI and architecture/owner-merges.md'

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
  '# summary = over live attempts only; longest = now minus the status.md start (on the cheap path, the event:path started), among running, waiting and blocked; an attempt without a start is not measured',
  `# shown: tasks whose live attempt is running, waiting or blocked, and the last ${FINISHED_SHOWN} merged or reported, each only while it merged or reported within the last ${FINISHED_SHOWN_HOURS}h; --all shows every task`,
  '# superseded = a journal event:superseded names the attempt and the attempt that replaced it (by); a task whose live attempt is superseded is left out of the summary and the default list, and every superseded attempt out of --json\'s UNKNOWN tally; --all lists it, NEXT reads — (superseded); its card names the successor, as --json does',
  '# model-mismatch = a line of .construct/roles.jsonl, written when a subagent ran on a model outside the one its .claude/agents definition names (the parent session\'s model when it names none or inherit); a card lists its attempts\' lines from the worktree, the summary counts them and the window\'s own from this repository; with none, nothing is printed',
  '# eddies = a budget-stop or budget-warn line of .construct/eddies.jsonl, written by the Eddies hook when a session, agent or workflow run reached a threshold of .claude/eddies.json or its warnRatio share; a card lists its attempts\' lines from the worktree, the summary counts them and the window\'s own from this repository; with none, nothing is printed',
  '# edge = contour.after of the Shredder matrix a tasks file names; UNKNOWN without one',
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

export function summaryLine(summary: Summary): string {
  const { running, waiting, blocked } = summary.counts
  const open = running + waiting + blocked
  let longest: string
  if (summary.longest === undefined)
    longest = open === 0 ? '— (nothing running, waiting or blocked)' : 'UNKNOWN (missing: status.md start)'
  else if (summary.longest.minutes < 0)
    longest = `clock skew (${-summary.longest.minutes} min ahead, ${summary.longest.task})`
  else
    longest = `${summary.longest.minutes} min (${summary.longest.task})`
  return `running ${running}, waiting ${waiting}, blocked ${blocked}, the longest — ${longest}`
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

function rowCells(row: Row, paint: Paint): string[] {
  const tone = toneOf(row)
  return [row.id, row.path, paint(tone, row.stage?.name ?? '—'), row.age === undefined ? '—' : formatAge(row.age), paint(tone, row.next.text)]
}

function tableLines(rows: Row[], paint: Paint): string[] {
  const grid: string[][] = [[...COLUMNS], ...rows.map(row => rowCells(row, paint))]
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

function hiddenLines(view: BoardView): string[] {
  const hidden = view.tasks.length - view.shown.length
  if (hidden === 0)
    return []
  const superseded = view.tasks.filter(task => isSuperseded(task.live)).length
  return [`hidden: ${hidden} tasks${superseded === 0 ? '' : ` (${superseded} superseded)`}, --all shows them`]
}

function mismatchSummaryLines(view: BoardView): string[] {
  const tasks = new Map(view.tasks.flatMap(task => task.attempts).map(attempt => [attempt.attempt.worktree ?? attempt.attempt.id, attempt.attempt.modelMismatches.length]))
  const inTasks = [...tasks.values()].reduce((sum, count) => sum + count, 0)
  const total = inTasks + view.windowMismatches.length
  return total === 0 ? [] : [`model-mismatch ${total}: window ${view.windowMismatches.length}, tasks ${inTasks} (a role ran on a model its definition does not name; .construct/roles.jsonl)`]
}

function budgetSummaryLines(view: BoardView): string[] {
  const byWorktree = new Map(view.tasks.flatMap(task => task.attempts).map(attempt => [attempt.attempt.worktree ?? attempt.attempt.id, attempt.attempt.budgetLines]))
  return budgetSummary(view.windowBudgetLines, [...byWorktree.values()].flat())
}

export function renderBoard(view: BoardView): string[] {
  return [
    summaryLine(view.summary),
    ...mismatchSummaryLines(view),
    ...budgetSummaryLines(view),
    ...hiddenLines(view),
    ...tableLines(view.shown.map(task => rowOf(task, view.nextOf, view.now)), view.paint),
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

export function renderCard(task: TaskView, view: BoardView): string[] {
  const row = rowOf(task, view.nextOf, view.now)
  return [
    ...tableLines([row], view.paint),
    ...attemptLines(task, view.details),
    `next ${row.next.text} (derived${row.next.why === undefined ? '' : `; ${row.next.why}`})`,
    ...edgeLines(task, view.edges),
  ]
}
