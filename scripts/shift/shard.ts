import type { GhRunner } from '../board/gh.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ATTACH_RECORD_FILE, readAttachRecord } from '../../src/commands/attach/record.js'
import { MANIFEST_FILE, readManifest } from '../../src/manifest.js'
import { prDetails } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { MERGE_DONE } from '../bus/executor.js'
import { PREFIX as MERGE_PREFIX } from './merge.js'
import { GHOST_JOURNAL, REPO } from './places.js'

export const PREFIX = '[shard] '
export const USAGE = 'usage: pnpm shard <shift dir> [--by <name>]'
export const SHARD_EVENT = 'shard'
export const SHARD_USED_EVENT = 'shard-used'
export const DELEGATED_EVENT = 'delegated'
export const VERSION_BRANCH = /^changeset-release\//
const STOPPING_CI = new Set(['red', 'unknown'])

export interface ShardDeps {
  cwd: string
  handoffDir: string
  append: (file: string, text: string) => void
  now: () => Date
  uuid: () => string
  by: () => string
  out: (line: string) => void
  err: (line: string) => void
}

export interface DelegationDeps {
  gh: GhRunner
  journal: string
  append: (file: string, text: string) => void
  now: () => Date
}

interface JournalLine {
  event?: unknown
  id?: unknown
  run?: unknown
}

function journalLines(text: string | null): JournalLine[] {
  return (text ?? '').split('\n').flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as JournalLine | null
      return parsed !== null && typeof parsed === 'object' ? [parsed] : []
    }
    catch {
      return []
    }
  })
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

export function shardRefusal(journal: string | null, id: string, run: string): string | null {
  const lines = journalLines(journal)
  const issued = lines.find(line => line.event === SHARD_EVENT && line.id === id)
  if (issued === undefined)
    return `no shard ${id} in the journal; pnpm shard ${run} issues one`
  if (issued.run !== run)
    return `shard ${id} was issued for ${String(issued.run)}, not for ${run}`
  if (lines.some(line => line.event === SHARD_USED_EVENT && line.id === id))
    return `shard ${id} was used once already; a shard is spent when its run ends`
  return null
}

export function slotRefusal(root: string): string | null {
  try {
    if (readAttachRecord(root) !== null)
      return `${ATTACH_RECORD_FILE} exists: the run is not INIT (attach); --slot delegates nothing`
    if (readManifest(root) === null)
      return `${MANIFEST_FILE} does not exist: the run is not INIT; --slot delegates nothing`
  }
  catch (error) {
    return `the construct record is not read (${firstLine(error)}); --slot delegates nothing`
  }
  return null
}

export function usedLine(id: string, run: string, now: Date): string {
  return `${JSON.stringify({ event: SHARD_USED_EVENT, id, run, ts: now.toISOString() })}\n`
}

function notApplied(number: string, shard: string, why: string): string[] {
  return [`${MERGE_PREFIX}PR #${number} ${why}; shard ${shard} not applied, merge is Eli's`]
}

export function delegatedMerge(deps: DelegationDeps, task: string, number: string, shard: string, reviewed?: string): string[] {
  let view: { headRefName: string, headRefOid: string }
  try {
    view = JSON.parse(deps.gh(['pr', 'view', number, '-R', REPO, '--json', 'headRefName,headRefOid'])) as typeof view
  }
  catch (error) {
    return notApplied(number, shard, `not read: ${firstLine(error)}`)
  }
  if (typeof view.headRefName !== 'string' || view.headRefName === '' || typeof view.headRefOid !== 'string' || view.headRefOid === '')
    return notApplied(number, shard, 'not read: the view names no head branch or commit')
  if (VERSION_BRANCH.test(view.headRefName))
    return notApplied(number, shard, `is a version pull request (${view.headRefName}) and stays the owner's`)
  const { ci } = prDetails(deps.gh, REPO, { number: Number(number), headRefName: view.headRefName, headRefOid: view.headRefOid, state: 'OPEN', mergedAt: null, mergeCommit: null })
  if (STOPPING_CI.has(ci.state))
    return notApplied(number, shard, `required checks ${ci.text}`)
  const head = reviewed ?? view.headRefOid
  const why = `owner decision delegated, shard ${shard}`
  deps.append(deps.journal, `${JSON.stringify({ event: DELEGATED_EVENT, task, pr: Number(number), shard, why, ts: deps.now().toISOString() })}\n`)
  return [`${MERGE_PREFIX}${why} — PR #${number} goes to the bus at ${head}; the chain waits for its ${MERGE_DONE}`]
}

export function runShard(argv: string[], deps: ShardDeps): number {
  const byAt = argv.indexOf('--by')
  const byArg = byAt === -1 ? undefined : argv[byAt + 1]
  const rest = argv.filter((_, index) => byAt === -1 || (index !== byAt && index !== byAt + 1))
  if (rest.length !== 1 || rest[0]!.startsWith('-') || (byAt !== -1 && (byArg === undefined || byArg.startsWith('-')))) {
    deps.err(`${PREFIX}${USAGE}`)
    return 1
  }
  const by = (byArg ?? deps.by()).trim()
  if (by === '') {
    deps.err(`${PREFIX}no issuer: pass --by <name> or set git config user.name`)
    return 1
  }
  const run = path.resolve(deps.cwd, rest[0]!)
  const id = deps.uuid()
  deps.append(path.join(deps.handoffDir, GHOST_JOURNAL), `${JSON.stringify({ event: SHARD_EVENT, id, by, ts: deps.now().toISOString(), run })}\n`)
  deps.out(`${PREFIX}shard ${id} issued by ${by} for ${run}; pnpm shift ${run} --slot ${id}`)
  return 0
}

function realDeps(): ShardDeps {
  return {
    cwd: process.cwd(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    uuid: randomUUID,
    by: () => {
      try {
        return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      }
      catch {
        return ''
      }
    },
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runShard(process.argv.slice(2), realDeps())
