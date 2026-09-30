import type { OwnerMergeKind } from '../shredder/reader.js'
import type { AttemptView, ChecksOf, TaskView } from './derive.js'
import type { GhRunner, PrDetails, PullRequest } from './gh.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseEverySeconds } from '../ghosts/every.js'
import { readOwnerMergeKinds } from '../shredder/reader.js'
import { deriveTasks, selectShown, summarize } from './derive.js'
import { FRAME_FILE, frameFileIn } from './frame.js'
import { listPrs, prDetails } from './gh.js'
import { readHandoff } from './handoff.js'
import { boardJson } from './json.js'
import { nextOf } from './next.js'
import { renderBoard, renderCard } from './render.js'
import { legendLines, painter } from './tone.js'

export const PREFIX = '[board] '
export const USAGE = 'usage: tsx scripts/board/board.ts [--dir <handoff dir>] [<task-id>] [--all] [--json] [--every <seconds>] [--repo E1i/mikoshi-construct] [--help]'
const DEFAULT_REPO = 'E1i/mikoshi-construct'
export const HANDOFF_DIR_VARIABLE = 'CONSTRUCT_HANDOFF_DIR'
const OWNER_MERGES = path.resolve(import.meta.dirname, '../../architecture/owner-merges.md')

export interface BoardDeps {
  gh: GhRunner
  now: Date
  defaultDir: string
  colour: boolean
}

export interface BoardResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
  everySeconds?: number
  frameFile?: string
}

interface Args {
  dir: string
  dirIsDefault: boolean
  repo: string
  all: boolean
  json: boolean
  id: string | undefined
  everySeconds: number | undefined
}

export const HELP = [
  USAGE,
  `--every <seconds> redraws the view: it clears a terminal before each frame and writes each frame as plain text to <handoff dir>/${FRAME_FILE}, replacing it through a temporary file and a rename; a run without --every writes nothing`,
  ...legendLines(),
]

function parseArgs(argv: string[], defaultDir: string): Args | string | 'help' {
  let dir: string | undefined
  let repo = DEFAULT_REPO
  let all = false
  let json = false
  let id: string | undefined
  let everySeconds: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') {
      return 'help'
    }
    else if (arg === '--all') {
      all = true
    }
    else if (arg === '--json') {
      json = true
    }
    else if (!arg.startsWith('-') && id === undefined) {
      id = arg
    }
    else if (arg === '--dir' || arg === '--repo' || arg === '--every') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--'))
        return `${arg} needs a value; ${USAGE}`
      if (arg === '--dir') {
        dir = value
      }
      else if (arg === '--repo') {
        repo = value
      }
      else {
        try {
          everySeconds = parseEverySeconds(value)
        }
        catch (error) {
          return `${(error as Error).message}; ${USAGE}`
        }
      }
      index += 1
    }
    else {
      return `unknown argument '${arg}'; ${USAGE}`
    }
  }
  if (json && id !== undefined)
    return `--json prints every task; drop '${id}' or --json; ${USAGE}`
  return { dir: dir ?? defaultDir, dirIsDefault: dir === undefined, repo, all, json, id, everySeconds }
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

class ChecksCache {
  private readonly read = new Map<number, PrDetails>()

  constructor(private readonly gh: GhRunner, private readonly repo: string) {}

  fetch(pr: PullRequest): PrDetails {
    if (!this.read.has(pr.number))
      this.read.set(pr.number, prDetails(this.gh, this.repo, pr))
    return this.read.get(pr.number)!
  }

  readonly unmerged: ChecksOf = pr => pr.mergedAt === null ? this.fetch(pr) : this.read.get(pr.number)

  readonly fetched: ChecksOf = pr => this.read.get(pr.number)

  byAttempt(views: AttemptView[]): Map<string, PrDetails> {
    const details = new Map<string, PrDetails>()
    for (const view of views) {
      if (view.pr.kind === 'found')
        details.set(view.attempt.id, this.fetch(view.pr.pr))
    }
    return details
  }
}

interface Selection {
  card: TaskView | undefined
  shown: TaskView[]
}

function select(tasks: TaskView[], args: Args, now: Date): Selection {
  return {
    card: args.id === undefined ? undefined : findTask(tasks, args.id),
    shown: selectShown(tasks, args.all && !args.json, now),
  }
}

function fetchedViews(tasks: TaskView[], { card, shown }: Selection, args: Args): AttemptView[] {
  if (args.json)
    return tasks.flatMap(task => task.attempts)
  if (card !== undefined)
    return card.attempts
  return shown.map(task => task.live)
}

export function runBoard(argv: string[], deps: BoardDeps): BoardResult {
  const args = parseArgs(argv, deps.defaultDir)
  if (args === 'help')
    return { stdout: HELP, stderr: [], exitCode: 0 }
  if (typeof args === 'string')
    return refuse(args)
  if (!existsSync(args.dir) || !statSync(args.dir).isDirectory()) {
    if (args.dirIsDefault)
      return refuse(`no handoff directory at ${args.dir}, the default; pass --dir <dir>, set ${HANDOFF_DIR_VARIABLE}, or link ${args.dir} to it`)
    return refuse(`no such directory: ${args.dir}`)
  }

  const handoff = readHandoff(args.dir)
  const prs = listPrs(deps.gh, args.repo)
  const checks = new ChecksCache(deps.gh, args.repo)
  const firstPass = deriveTasks(handoff.attempts, prs, checks.unmerged)
  const firstSelection = select(firstPass, args, deps.now)
  if (args.id !== undefined && firstSelection.card === undefined)
    return refuse(`no task or attempt '${args.id}' in ${args.dir}`)
  checks.byAttempt(fetchedViews(firstPass, firstSelection, args))
  const tasks = deriveTasks(handoff.attempts, prs, checks.fetched)
  const { card, shown } = select(tasks, args, deps.now)
  const details = checks.byAttempt(fetchedViews(tasks, { card, shown }, args))
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
    paint: painter(deps.colour),
  }
  let stdout: string[]
  if (args.json)
    stdout = [JSON.stringify(boardJson(view), null, 2)]
  else if (card !== undefined)
    stdout = renderCard(card, view)
  else
    stdout = renderBoard(view)
  if (args.everySeconds === undefined)
    return { stdout, stderr, exitCode: 0 }
  return { stdout: [`${PREFIX}frame ${deps.now.toISOString()}`, ...stdout], stderr, exitCode: 0, everySeconds: args.everySeconds, frameFile: frameFileIn(args.dir) }
}
