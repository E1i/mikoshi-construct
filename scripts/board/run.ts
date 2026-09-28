import type { GhRunner } from './gh.js'
import { existsSync, statSync } from 'node:fs'
import { deriveTasks, selectShown, summarize } from './derive.js'
import { listPrs, prChecks } from './gh.js'
import { readHandoff } from './handoff.js'
import { renderBoard } from './render.js'

export const PREFIX = '[board] '
export const USAGE = 'usage: tsx scripts/board/board.ts --dir <handoff dir> [--all] [--repo E1i/mikoshi-construct]'
const DEFAULT_REPO = 'E1i/mikoshi-construct'

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
}

function parseArgs(argv: string[]): Args | string {
  let dir: string | undefined
  let repo = DEFAULT_REPO
  let all = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all') {
      all = true
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
  return { dir, repo, all }
}

function refuse(message: string): BoardResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
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
  const shown = selectShown(tasks, args.all)
  const checks = new Map<string, string>()
  for (const task of shown) {
    for (const view of task.attempts) {
      if (view.pr.kind === 'found')
        checks.set(view.attempt.id, prChecks(deps.gh, args.repo, view.pr.pr))
    }
  }

  const stderr = handoff.warnings.map(warning => `${PREFIX}${warning}`)
  if (prs.kind === 'failed')
    stderr.push(`${PREFIX}gh pr list failed; every PR fact is UNKNOWN`)

  const stdout = renderBoard({ tasks, shown, summary: summarize(tasks, deps.now), edges: handoff.edges, checks, all: args.all })
  return { stdout, stderr, exitCode: 0 }
}
