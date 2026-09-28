import type { AttemptView, Summary, TaskView } from './derive.js'
import type { PrDetails } from './gh.js'
import type { Age, NextOf, Row } from './row.js'
import { MERGED_SHOWN, stageText } from './derive.js'
import { rowOf, unknownTally } from './row.js'

export interface BoardView {
  tasks: TaskView[]
  shown: TaskView[]
  summary: Summary
  edges: string[] | undefined
  details: Map<string, PrDetails>
  nextOf: NextOf
  now: Date
}

const SEPARATOR = ' · '

export const ROW_DEFINITION = '# TASK · PATH · STAGE · AGE · NEXT — TASK = the live attempt; PATH = ladder or cheap; STAGE = the latest stage recorded done; AGE = the time since it, "clock skew" when that time is ahead of now; NEXT (derived) = what the task waits for and from whom, from the stage, the PR\'s CI and architecture/owner-merges.md'

export const DEFINITIONS = [
  '# board: read-only; a stage is a recorded fact, — when it did not happen, or UNKNOWN naming the record that is missing',
  '# stages: brief = brief file mtime · approved = <brief>.approved-sha256 mtime · ghost = journal event:task ts · review = last journal event:review · ready = UNKNOWN on the ladder: ready is recorded only on the cheap path · merged = journal event:merge, else gh mergedAt',
  '# cheap path (a journal event:path line with path cheap): started → ready → pr → merged; started, ready and pr from that line, merged = journal event:merge, else gh mergedAt of that PR number; no brief, approved, ghost or review stages',
  '# — = did not happen: not merged while the last review verdict is changes, no PR for the branch, a PR not merged, a ghost still running',
  '# UNKNOWN = a record could exist and does not; the missing record is named',
  '# task (derived) = the attempts whose tasks-file entries name one brief file; the latest attempt is live, the others are history',
  '# latest (derived) = ordered by the status.md start of ghost-<id>, else by the mtime of the newest tasks file naming it',
  '# status.md times carry no zone; they are read as this machine\'s local time',
  '# merged = a journal event:merge or a gh mergedAt exists',
  '# running = not merged, and its status.md row ghost-<id> has state writing, reviewing or reading; on the cheap path, not merged and no ready recorded',
  '# blocked = not merged, not running, and the journal records exit != 0, a ladder outcome other than "done", or a last review verdict "changes"',
  '# waiting = not merged, not running, not blocked, and a journal event:task exists (ladder finished, nothing after it recorded); on the cheap path, not merged and ready recorded',
  '# summary = over live attempts only; longest = now minus the status.md start (on the cheap path, the event:path started), among running, waiting and blocked; an attempt without a start is not measured',
  `# shown: tasks whose live attempt is running, waiting or blocked, and the last ${MERGED_SHOWN} merged; --all shows every task`,
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

export function rowLine(row: Row): string {
  return [row.id, row.path, row.stage?.name ?? '—', row.age === undefined ? '—' : formatAge(row.age), row.next.text].join(SEPARATOR)
}

export function unknownLine(views: AttemptView[]): string {
  const tally = [...unknownTally(views)].map(([event, count]) => `${event} ×${count}`)
  return `UNKNOWN: ${tally.join(', ') || 'none'}`
}

function hiddenLine(view: BoardView): string {
  const hidden = view.tasks.length - view.shown.length
  return `# pnpm board <task-id> prints one task's card with every attempt; --json prints everything; hidden: ${hidden === 0 ? 'none' : `${hidden} tasks, --all shows them`}`
}

export function renderBoard(view: BoardView): string[] {
  return [
    summaryLine(view.summary),
    ROW_DEFINITION,
    hiddenLine(view),
    ...view.shown.map(task => rowLine(rowOf(task, view.nextOf, view.now))),
    unknownLine(view.shown.map(task => task.live)),
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
    ...DEFINITIONS,
    '',
    rowLine(row),
    ...attemptLines(task, view.details),
    `next ${row.next.text} (derived${row.next.why === undefined ? '' : `; ${row.next.why}`})`,
    ...edgeLines(task, view.edges),
    unknownLine(task.attempts),
  ]
}
