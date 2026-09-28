import type { OwnerMergeKind } from '../shredder/reader.js'
import type { AttemptView, TaskView } from './derive.js'
import type { GhRunner, PrDetails } from './gh.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { readOwnerMergeKinds } from '../shredder/reader.js'
import { deriveTasks, selectShown, summarize } from './derive.js'
import { listPrs, prDetails } from './gh.js'
import { readHandoff } from './handoff.js'
import { boardJson } from './json.js'
import { nextOf } from './next.js'
import { renderBoard, renderCard } from './render.js'

export const PREFIX = '[board] '
export const USAGE = 'usage: tsx scripts/board/board.ts --dir <handoff dir> [<task-id>] [--all] [--json] [--repo E1i/mikoshi-construct]'
const DEFAULT_REPO = 'E1i/mikoshi-construct'
const OWNER_MERGES = path.resolve(import.meta.dirname, '../../architecture/owner-merges.md')

export interface BoardDeps {
  gh: GhRunner
  now: Date
}

export interface BoardResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

interface Args {
  dir: string
  repo: string
  all: boolean
  json: boolean
  id: string | undefined
}

function parseArgs(argv: string[]): Args | string {
  let dir: string | undefined
  let repo = DEFAULT_REPO
  let all = false
  let json = false
  let id: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all') {
      all = true
    }
    else if (arg === '--json') {
      json = true
    }
    else if (!arg.startsWith('-') && id === undefined) {
      id = arg
    }
    else if (arg === '--dir' || arg === '--repo') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--'))
        return `${arg} needs a value; ${USAGE}`
      if (arg === '--dir')
        dir = value
      else
        repo = value
      index += 1
    }
    else {
      return `unknown argument '${arg}'; ${USAGE}`
    }
  }
  if (dir === undefined)
    return `--dir is required; ${USAGE}`
  if (json && id !== undefined)
    return `--json prints every task; drop '${id}' or --json; ${USAGE}`
  return { dir, repo, all, json, id }
}

function refuse(message: string): BoardResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
}

function readKinds(): OwnerMergeKind[] | undefined {
  try {
    return readOwnerMergeKinds(readFileSync(OWNER_MERGES, 'utf8'))
  }
  catch {
    return undefined
  }
}

function findTask(tasks: TaskView[], id: string): TaskView | undefined {
  return tasks.find(task => task.name === id || task.attempts.some(view => view.attempt.id === id))
}

function fetchDetails(gh: GhRunner, repo: string, views: AttemptView[]): Map<string, PrDetails> {
  const details = new Map<string, PrDetails>()
  for (const view of views) {
    if (view.pr.kind === 'found')
      details.set(view.attempt.id, prDetails(gh, repo, view.pr.pr))
  }
  return details
}

export function runBoard(argv: string[], deps: BoardDeps): BoardResult {
  const args = parseArgs(argv)
  if (typeof args === 'string')
    return refuse(args)
  if (!existsSync(args.dir) || !statSync(args.dir).isDirectory())
    return refuse(`no such directory: ${args.dir}`)

  const handoff = readHandoff(args.dir)
  const prs = listPrs(deps.gh, args.repo)
  const tasks = deriveTasks(handoff.attempts, prs)
  const card = args.id === undefined ? undefined : findTask(tasks, args.id)
  if (args.id !== undefined && card === undefined)
    return refuse(`no task or attempt '${args.id}' in ${args.dir}`)
  const shown = selectShown(tasks, args.all && !args.json)
  let fetched: AttemptView[]
  if (args.json)
    fetched = tasks.flatMap(task => task.attempts)
  else if (card !== undefined)
    fetched = card.attempts
  else
    fetched = shown.map(task => task.live)
  const details = fetchDetails(deps.gh, args.repo, fetched)
  const kinds = readKinds()

  const stderr = handoff.warnings.map(warning => `${PREFIX}${warning}`)
  if (prs.kind === 'failed')
    stderr.push(`${PREFIX}gh pr list failed; every PR fact is UNKNOWN`)
  if (kinds === undefined)
    stderr.push(`${PREFIX}architecture/owner-merges.md unreadable; a merge NEXT is UNKNOWN`)

  const view = {
    tasks,
    shown,
    summary: summarize(tasks, deps.now),
    edges: handoff.edges,
    details,
    nextOf: (attempt: AttemptView) => nextOf(attempt, details.get(attempt.attempt.id), kinds),
    now: deps.now,
  }
  let stdout: string[]
  if (args.json)
    stdout = [JSON.stringify(boardJson(view), null, 2)]
  else if (card !== undefined)
    stdout = renderCard(card, view)
  else
    stdout = renderBoard(view)
  return { stdout, stderr, exitCode: 0 }
}
