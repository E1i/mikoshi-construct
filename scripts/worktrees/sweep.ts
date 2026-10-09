import type { GhRunner } from '../board/gh.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { REPO } from '../shift/places.js'

export const PREFIX = '[worktrees:sweep] '
export const USAGE = 'usage: pnpm worktrees:sweep [--apply] [--card <id>]'
const APPLY_FLAG = '--apply'
const CARD_FLAG = '--card'

export interface SweepDeps {
  cwd: string
  handoffDir: string
  git: (cwd: string, args: string[]) => string
  gh: GhRunner
  readJournal: (file: string) => string | null
}

export interface SweepResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

interface Worktree {
  path: string
  branch?: string
  head?: string
  locked: boolean
  prunable: boolean
}

interface CardRecord {
  merged: boolean
  mergedPr?: number
  closedPr?: number
  closedByReport: boolean
}

interface Journal {
  byTree: Map<string, string>
  cards: Map<string, CardRecord>
  closedPrs: Set<number>
}

type Verdict = { kind: 'remove', why: string } | { kind: 'keep', why: string }

function entries(text: string | null): Record<string, unknown>[] {
  return (text ?? '').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown> | null
      return entry === null || typeof entry !== 'object' ? [] : [entry]
    }
    catch {
      return []
    }
  })
}

function journalOf(text: string | null): Journal {
  const cards = new Map<string, CardRecord>()
  const byTree = new Map<string, string>()
  const closedPrs = new Set<number>()
  const recordOf = (task: string): CardRecord => {
    const known = cards.get(task) ?? { merged: false, closedByReport: false }
    cards.set(task, known)
    return known
  }
  for (const entry of entries(text)) {
    if (entry.event === 'merge-skip' && entry.skip === 'closed' && typeof entry.pr === 'number')
      closedPrs.add(entry.pr)
    if (typeof entry.task !== 'string')
      continue
    if (entry.event === 'merge') {
      Object.assign(recordOf(entry.task), { merged: true }, typeof entry.pr === 'number' ? { mergedPr: entry.pr } : {})
    }
    else if (entry.event === 'path' && typeof entry.worktree === 'string') {
      recordOf(entry.task)
      byTree.set(entry.worktree, entry.task)
    }
    else if (entry.event === 'path' && typeof entry.verification === 'string') {
      const record = recordOf(entry.task)
      if (typeof entry.pr === 'number')
        record.closedPr = entry.pr
      else if (typeof entry.report === 'string')
        record.closedByReport = true
    }
  }
  return { byTree, cards, closedPrs }
}

function worktreesOf(porcelain: string): Worktree[] {
  return porcelain.split('\n\n').map(block => block.split('\n').filter(line => line !== '')).filter(lines => lines.length > 0).map((lines) => {
    const field = (name: string): string | undefined => lines.find(line => line.startsWith(`${name} `))?.slice(name.length + 1)
    const branch = field('branch')
    return {
      path: field('worktree')!,
      ...(branch === undefined ? {} : { branch: branch.replace(/^refs\/heads\//, '') }),
      ...(field('HEAD') === undefined ? {} : { head: field('HEAD') }),
      locked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
      prunable: lines.some(line => line === 'prunable' || line.startsWith('prunable ')),
    }
  })
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

function mergedHead(deps: SweepDeps, pr: number): string | undefined {
  try {
    const view = JSON.parse(deps.gh(['pr', 'view', String(pr), '-R', REPO, '--json', 'headRefOid'])) as { headRefOid?: unknown }
    return typeof view.headRefOid === 'string' ? view.headRefOid : undefined
  }
  catch {
    return undefined
  }
}

function cardState(id: string, record: CardRecord, closedPrs: ReadonlySet<number>): Verdict {
  if (record.merged || record.closedByReport)
    return { kind: 'remove', why: `card #${id} is merged` }
  if (record.closedPr === undefined)
    return { kind: 'keep', why: `card #${id} is open` }
  return closedPrs.has(record.closedPr)
    ? { kind: 'remove', why: `card #${id} is closed and PR #${record.closedPr} was closed without a merge` }
    : { kind: 'keep', why: `card #${id} is closed but PR #${record.closedPr} is still open (no merge line in the journal)` }
}

function treeState(deps: SweepDeps, tree: Worktree, record: CardRecord): string | null {
  const changed = deps.git(tree.path, ['status', '--porcelain']).split('\n').filter(line => line !== '').length
  if (changed > 0)
    return `${changed} changed ${changed === 1 ? 'path' : 'paths'} in the tree`
  const unpushed = deps.git(tree.path, ['rev-list', 'HEAD', '--not', '--remotes']).split('\n').filter(line => line !== '').length
  if (unpushed === 0)
    return null
  const squashed = record.mergedPr !== undefined && tree.head !== undefined && mergedHead(deps, record.mergedPr) === tree.head
  return squashed ? null : `${unpushed} ${unpushed === 1 ? 'commit' : 'commits'} reachable from no remote ref`
}

function verdictOf(deps: SweepDeps, tree: Worktree, id: string | undefined, journal: Journal): Verdict {
  const record = id === undefined ? undefined : journal.cards.get(id)
  if (tree.prunable)
    return { kind: 'keep', why: 'its directory is gone; git worktree prune drops the record' }
  if (tree.locked)
    return { kind: 'keep', why: 'the tree is locked' }
  if (id === undefined || record === undefined)
    return { kind: 'keep', why: 'named by no task:start line in the journal' }
  if (tree.branch === undefined)
    return { kind: 'keep', why: `card #${id}: the tree has a detached HEAD, no branch to remove` }
  const state = cardState(id, record, journal.closedPrs)
  if (state.kind === 'keep')
    return state
  try {
    const dirty = treeState(deps, tree, record)
    return dirty === null ? state : { kind: 'keep', why: `${state.why}, but ${dirty}` }
  }
  catch (error) {
    return { kind: 'keep', why: `card #${id}: the tree cannot be read: ${firstLine(error)}` }
  }
}

function argsOf(argv: string[]): { apply: boolean, card: string | undefined } | null {
  const at = argv.indexOf(CARD_FLAG)
  const card = at === -1 ? undefined : argv[at + 1]?.replace(/^#/, '')
  if (at !== -1 && (card === undefined || !/^\d+$/.test(card)))
    return null
  const rest = argv.filter((arg, index) => arg !== APPLY_FLAG && (at === -1 || (index !== at && index !== at + 1)))
  return rest.length === 0 ? { apply: argv.includes(APPLY_FLAG), card } : null
}

export function runSweep(argv: string[], deps: SweepDeps): SweepResult {
  const args = argsOf(argv)
  if (args === null)
    return { stdout: [], stderr: [`${PREFIX}${USAGE}`], exitCode: 1 }
  let trees: Worktree[]
  let here: string
  try {
    here = deps.git(deps.cwd, ['rev-parse', '--show-toplevel']).trim()
    trees = worktreesOf(deps.git(deps.cwd, ['worktree', 'list', '--porcelain']))
  }
  catch (error) {
    return { stdout: [], stderr: [`${PREFIX}not inside a git repository: ${firstLine(error)}`], exitCode: 1 }
  }
  const [main, ...linked] = trees
  const journal = journalOf(deps.readJournal(path.join(deps.handoffDir, 'ghosts.jsonl')))
  const stdout: string[] = []
  const stderr: string[] = []
  const kept: string[] = []
  for (const tree of linked) {
    const id = journal.byTree.get(tree.path)
    if (args.card !== undefined && id !== args.card)
      continue
    const verdict = tree.path === here ? { kind: 'keep', why: 'the sweep runs in this tree' } as const : verdictOf(deps, tree, id, journal)
    if (verdict.kind === 'keep') {
      kept.push(`${PREFIX}kept ${tree.path}: ${verdict.why}`)
      continue
    }
    if (!args.apply) {
      stdout.push(`${PREFIX}would remove ${tree.path} and branch ${tree.branch}: ${verdict.why}, the tree clean, every commit pushed`)
      continue
    }
    try {
      deps.git(main!.path, ['worktree', 'remove', tree.path])
      deps.git(main!.path, ['branch', '-D', tree.branch!])
      stdout.push(`${PREFIX}removed ${tree.path} and branch ${tree.branch}: ${verdict.why}`)
    }
    catch (error) {
      stderr.push(`${PREFIX}${tree.path} not removed: ${firstLine(error)}`)
    }
  }
  const none = args.card !== undefined && stdout.length + kept.length + stderr.length === 0 ? [`${PREFIX}card #${args.card} has no worktree to sweep`] : []
  const summary = `${PREFIX}${args.apply ? 'removed' : 'would remove'} ${stdout.length}, kept ${kept.length}${args.apply || stdout.length === 0 ? '' : `; ${APPLY_FLAG} removes them`}`
  return { stdout: [...stdout, ...kept, ...none, summary], stderr, exitCode: stderr.length === 0 ? 0 : 1 }
}

export function realSweepDeps(): SweepDeps {
  return {
    cwd: process.cwd(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    gh: execGh,
    readJournal: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runSweep(process.argv.slice(2), realSweepDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
