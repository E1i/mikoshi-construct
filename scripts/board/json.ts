import type { AttemptView, Stage } from './derive.js'
import type { Next } from './next.js'
import type { BoardView } from './render.js'
import type { Tree } from './tree.js'
import { isSuperseded, stageText } from './derive.js'
import { attemptEddies, windowText } from './render.js'
import { rowOf, unknownTally } from './row.js'
import { staleAge } from './stale.js'

export const JSON_FORMAT = 'board/4'

function nextJson(next: Next): Omit<Next, 'why'> & { why: string | null } {
  return { ...next, why: next.why ?? null }
}

function stageJson(stage: Stage): Stage & { text: string } {
  return { ...stage, text: stageText(stage) }
}

function prJson(view: AttemptView): unknown {
  if (view.pr.kind === 'found') {
    const { number, title, headRefName, headRefOid, state, mergedAt } = view.pr.pr
    return { kind: 'found', number, title: title ?? null, headRefName, headRefOid, state, mergedAt, via: view.pr.via ?? null }
  }
  return view.pr.kind === 'none' ? { kind: 'none', branch: view.attempt.branch ?? null } : { kind: 'unknown', missing: view.pr.missing }
}

function treeJson(tree: Tree | undefined): unknown {
  return tree === undefined ? null : { worktree: tree.worktree, branch: tree.branch ?? null, gone: tree.gone, dirty: tree.dirty ?? null }
}

function attemptJson(view: AttemptView, live: boolean, board: BoardView): unknown {
  const details = board.details.get(view.attempt.id)
  return {
    id: view.attempt.id,
    branch: view.attempt.branch ?? null,
    worktree: view.attempt.worktree ?? null,
    window: {
      session: view.attempt.window.session ?? null,
      lastAt: view.attempt.window.lastAt?.toISOString() ?? null,
      ended: view.attempt.window.ended,
      context: view.attempt.window.context ?? null,
      text: windowText(view, board.now),
    },
    eddies: (({ context, stop, warn }) => ({ context: context ?? null, stop, warn }))(attemptEddies(view)),
    tree: treeJson(board.trees.get(view.attempt.id)),
    stages: view.stages.map(stageJson),
    facts: view.facts.map(stageJson),
    pr: prJson(view),
    ci: details?.ci ?? null,
    files: details?.files ?? null,
    superseded: view.attempt.supersededEvent === undefined ? null : { by: view.attempt.supersededEvent.by, ts: view.attempt.supersededEvent.ts },
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
    window: board.miko === undefined ? null : { session: board.miko.session, context: board.miko.context ?? null, contextLimit: board.limits?.contextLimit ?? null, warnPercent: board.contextWarnPercent ?? (board.limits === undefined ? null : Math.round(board.limits.warnRatio * 100)) },
    derived: { summary: { counts: board.summary.counts, stale: board.summary.stale, finished: board.summary.finished, longest: board.summary.longest ?? null, windowsLive: board.summary.windowsLive } },
    unregistered: board.unregistered.map(tree => ({ worktree: tree.worktree, branch: tree.branch ?? null, dirty: tree.dirty ?? null, scratch: tree.scratch })),
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
          stale: staleAge(task.live, board.now, board.staleHours) ?? null,
          shownByDefault: shown.has(task.name),
        },
      }
    }),
    edges: board.edges ?? null,
    unknown: Object.fromEntries(unknownTally(board.tasks.flatMap(task => task.attempts).filter(view => !isSuperseded(view)))),
  }
}
