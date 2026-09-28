import type { AttemptView, Stage } from './derive.js'
import type { Next } from './next.js'
import type { BoardView } from './render.js'
import { stageText } from './derive.js'
import { rowOf, unknownTally } from './row.js'

export const JSON_FORMAT = 'board/1'

function nextJson(next: Next): Omit<Next, 'why'> & { why: string | null } {
  return { ...next, why: next.why ?? null }
}

function stageJson(stage: Stage): Stage & { text: string } {
  return { ...stage, text: stageText(stage) }
}

function prJson(view: AttemptView): unknown {
  if (view.pr.kind === 'found') {
    const { number, title, headRefName, headRefOid, state, mergedAt } = view.pr.pr
    return { kind: 'found', number, title: title ?? null, headRefName, headRefOid, state, mergedAt }
  }
  return view.pr.kind === 'none' ? { kind: 'none', branch: view.attempt.branch ?? null } : { kind: 'unknown', missing: view.pr.missing }
}

function attemptJson(view: AttemptView, live: boolean, board: BoardView): unknown {
  const details = board.details.get(view.attempt.id)
  return {
    id: view.attempt.id,
    branch: view.attempt.branch ?? null,
    stages: view.stages.map(stageJson),
    facts: view.facts.map(stageJson),
    pr: prJson(view),
    ci: details?.ci ?? null,
    files: details?.files ?? null,
    derived: {
      path: view.path,
      category: view.category,
      live,
      next: nextJson(board.nextOf(view)),
    },
  }
}

export function boardJson(board: BoardView): Record<string, unknown> {
  const shown = new Set(board.shown.map(task => task.name))
  return {
    format: JSON_FORMAT,
    now: board.now.toISOString(),
    derived: { summary: { counts: board.summary.counts, longest: board.summary.longest ?? null } },
    tasks: board.tasks.map((task) => {
      const row = rowOf(task, board.nextOf, board.now)
      return {
        attempts: task.attempts.map(view => attemptJson(view, view === task.live, board)),
        derived: {
          task: task.name,
          live: row.id,
          path: row.path,
          stage: row.stage ?? null,
          age: row.age ?? null,
          next: nextJson(row.next),
          category: task.live.category,
          shownByDefault: shown.has(task.name),
        },
      }
    }),
    edges: board.edges ?? null,
    unknown: Object.fromEntries(unknownTally(board.tasks.flatMap(task => task.attempts))),
  }
}
