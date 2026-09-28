import type { Summary, TaskView } from './derive.js'
import { isUnknown, MERGED_SHOWN } from './derive.js'

export interface BoardView {
  tasks: TaskView[]
  shown: TaskView[]
  summary: Summary
  edges: string[] | undefined
  checks: Map<string, string>
  all: boolean
}

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
  `# shown: tasks whose live attempt is running, waiting or blocked, and the last ${MERGED_SHOWN} merged; --all shows every task and its history`,
  '# edge = contour.after of the Shredder matrix a tasks file names; UNKNOWN without one',
]

export function summaryLine(summary: Summary): string {
  const { running, waiting, blocked } = summary.counts
  const open = running + waiting + blocked
  const longest = summary.longest !== undefined
    ? `${summary.longest.minutes} min (${summary.longest.task})`
    : open === 0 ? '— (nothing running, waiting or blocked)' : 'UNKNOWN (missing: status.md start)'
  return `running ${running}, waiting ${waiting}, blocked ${blocked}, the longest — ${longest}`
}

function taskLines(task: TaskView, checks: Map<string, string>): string[] {
  const history = task.attempts.filter(view => view !== task.live).map(view => view.attempt.id)
  const lines = [`task ${task.name} (derived) live ${task.live.attempt.id} ${task.live.category}${history.length > 0 ? `, history ${history.join(', ')}` : ''}`]
  for (const view of task.attempts) {
    lines.push(`  ${view.attempt.id} ${view === task.live ? 'live' : 'history'} ${view.category}`)
    for (const line of [...view.stages, ...view.facts]) {
      const ci = line.name === 'pr' ? checks.get(view.attempt.id) : undefined
      lines.push(`    ${line.name} ${line.text}${ci === undefined ? '' : `, ci ${ci}`}`)
    }
  }
  return lines
}

function unknownTally(shown: TaskView[]): string {
  const tally = new Map<string, number>()
  let total = 0
  for (const task of shown) {
    for (const view of task.attempts) {
      total += 1
      for (const stage of view.stages) {
        if (isUnknown(stage.text))
          tally.set(stage.name, (tally.get(stage.name) ?? 0) + 1)
      }
    }
  }
  return `# UNKNOWN per stage over shown attempts: ${[...tally].map(([name, count]) => `${name} ${count}/${total}`).join(', ') || 'none'}`
}

export function renderBoard(view: BoardView): string[] {
  const lines = [summaryLine(view.summary), ...DEFINITIONS, '']
  for (const task of view.shown)
    lines.push(...taskLines(task, view.checks))
  lines.push('')
  if (view.edges === undefined)
    lines.push('edge: UNKNOWN')
  else
    lines.push(...(view.edges.length > 0 ? view.edges.map(edge => `edge: ${edge}`) : ['edge: — (the matrix records no after)']))
  lines.push('')
  if (!view.all) {
    const attempts = view.tasks.reduce((sum, task) => sum + task.attempts.length, 0)
    const shownAttempts = view.shown.reduce((sum, task) => sum + task.attempts.length, 0)
    lines.push(`# hidden: ${view.tasks.length - view.shown.length} tasks and ${attempts - shownAttempts} attempts; --all shows them`)
  }
  lines.push(unknownTally(view.shown))
  return lines
}
