import type { BusEvent } from '../bus/db.js'
import type { WindowScope, WindowShard } from '../bus/shards.js'
import type { GhRunner } from '../core/gh.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ATTACH_RECORD_FILE, readAttachRecord } from '../../src/commands/attach/record.js'
import { MANIFEST_FILE, readManifest } from '../../src/manifest.js'
import { appendEvent, defaultBusPath, openBus } from '../bus/db.js'
import { activeWindowShards, decisionsInForceAt, isWindowScope, WINDOW_SHARD_HOURS, windowShardEnded } from '../bus/shards.js'
import { MERGE_DONE, SHARD_ISSUED, SHARD_REVOKED, SHARD_USED } from '../core/events.js'
import { prDetails } from '../core/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../core/handoff-dir.js'
import { PREFIX as MERGE_PREFIX } from './merge.js'
import { GHOST_JOURNAL, REPO } from './places.js'

export const PREFIX = '[shard] '
export const USAGE = 'usage: pnpm shard <shift dir> | --card <n> | --pr <n> [--under D-<id>] | --window [--hours <n>] [--scope merge|merge+decisions] | --stop [--by <name>]'
export const SHARD_EVENT = 'shard'
export const SHARD_USED_EVENT = 'shard-used'
export const DELEGATED_EVENT = 'delegated'
export const VERSION_BRANCH = /^changeset-release\//
const STOPPING_CI = new Set(['red', 'unknown'])
const VALUED_FLAGS = ['--by', '--card', '--pr', '--under', '--hours', '--scope']
const WINDOW_FLAG = '--window'
const STOP_FLAG = '--stop'
const DECISION_ID = /^D-([1-9]\d*)$/
const HOUR_MS = 3_600_000

export interface ShardDeps {
  cwd: string
  handoffDir: string
  append: (file: string, text: string) => void
  record: (event: BusEvent) => void
  activeWindows: (now: Date) => WindowShard[]
  inForce: (decisionId: number, now: Date) => boolean
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

export function usedEvent(id: string, run: string, now: Date): BusEvent {
  return { ts: now.toISOString(), type: SHARD_USED, actor: `worker:shift:${path.basename(run)}`, cardId: null, pr: null, head: null, dedupeKey: `${SHARD_USED}:${id}`, payload: { id, run }, legacy: false }
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

interface ShardTarget {
  run: string | null
  card: number | null
  pr: number | null
}

function positiveInteger(value: string | undefined): number | null {
  const number = Number(value)
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : null
}

function targetOf(cwd: string, rest: string[], card: string | undefined, pr: string | undefined): ShardTarget | null {
  if (card === undefined && pr === undefined)
    return rest.length === 1 && !rest[0]!.startsWith('-') ? { run: path.resolve(cwd, rest[0]!), card: null, pr: null } : null
  const target = { run: null, card: positiveInteger(card), pr: positiveInteger(pr) }
  if (rest.length > 0 || (card !== undefined && target.card === null) || (pr !== undefined && target.pr === null))
    return null
  return target
}

function coveredBy(target: ShardTarget, id: string): string {
  if (target.run !== null)
    return `${target.run}; pnpm shift ${target.run} --slot ${id}`
  const named = [target.card === null ? null : `card #${target.card}`, target.pr === null ? null : `PR #${target.pr}`].filter(name => name !== null).join(' and ')
  return `${named}; the merge worker merges its owner pull request under owner_under_shard once`
}

interface WindowOrder {
  hours: number
  scope: WindowScope
}

function windowOrderOf(hoursArg: string | undefined, scopeArg: string | undefined): WindowOrder | null {
  const hours = hoursArg === undefined ? WINDOW_SHARD_HOURS : positiveInteger(hoursArg)
  const scope = scopeArg ?? 'merge'
  return hours === null || !isWindowScope(scope) ? null : { hours, scope }
}

function usage(deps: ShardDeps): number {
  deps.err(`${PREFIX}${USAGE}`)
  return 1
}

function issuerOf(deps: ShardDeps, byArg: string | undefined): string | null {
  const by = (byArg ?? deps.by()).trim()
  if (by !== '')
    return by
  deps.err(`${PREFIX}no issuer: pass --by <name> or set git config user.name`)
  return null
}

function issueWindow(deps: ShardDeps, by: string, order: WindowOrder): number {
  const id = deps.uuid()
  const now = deps.now()
  const ts = now.toISOString()
  const until = new Date(now.getTime() + order.hours * HOUR_MS).toISOString()
  deps.record({ ts, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by, run: null, window: true, scope: order.scope, until }, legacy: false })
  deps.append(path.join(deps.handoffDir, GHOST_JOURNAL), `${JSON.stringify({ event: SHARD_EVENT, id, by, ts, window: true, scope: order.scope, until })}\n`)
  deps.out(`${PREFIX}shard ${id} issued by ${by} for the window, scope ${order.scope}, until ${until}; pnpm shard ${STOP_FLAG} revokes it`)
  return 0
}

function revokeWindows(deps: ShardDeps): number {
  const now = deps.now()
  const active = deps.activeWindows(now)
  if (active.length === 0) {
    deps.err(`${PREFIX}no active window shard to revoke`)
    return 1
  }
  for (const shard of active) {
    deps.record(windowShardEnded(SHARD_REVOKED, 'owner', shard.id, now))
    deps.out(`${PREFIX}shard ${shard.id} revoked`)
  }
  return 0
}

export function runShard(argv: string[], deps: ShardDeps): number {
  const ats = VALUED_FLAGS.map(flag => argv.indexOf(flag))
  const [byArg, cardArg, prArg, underArg, hoursArg, scopeArg] = ats.map(at => at === -1 ? undefined : argv[at + 1])
  const taken = ats.filter(at => at !== -1).flatMap(at => [at, at + 1])
  const rest = argv.filter((_, index) => !taken.includes(index))
  if (ats.some(at => at !== -1 && (argv[at + 1] === undefined || argv[at + 1]!.startsWith('-'))))
    return usage(deps)
  const window = rest.includes(WINDOW_FLAG)
  const stop = rest.includes(STOP_FLAG)
  const positional = rest.filter(arg => arg !== WINDOW_FLAG && arg !== STOP_FLAG)
  const aimed = cardArg !== undefined || prArg !== undefined || underArg !== undefined || positional.length > 0
  if (stop)
    return window || aimed || hoursArg !== undefined || scopeArg !== undefined ? usage(deps) : revokeWindows(deps)
  if (window) {
    const order = windowOrderOf(hoursArg, scopeArg)
    if (aimed || order === null)
      return usage(deps)
    const issuer = issuerOf(deps, byArg)
    return issuer === null ? 1 : issueWindow(deps, issuer, order)
  }
  const target = targetOf(deps.cwd, rest, cardArg, prArg)
  const under = underArg === undefined ? null : Number(DECISION_ID.exec(underArg)?.[1] ?? Number.NaN)
  if (target === null || Number.isNaN(under) || (under !== null && target.run !== null) || hoursArg !== undefined || scopeArg !== undefined)
    return usage(deps)
  if (under !== null && !deps.inForce(under, deps.now())) {
    deps.err(`${PREFIX}D-${under} is not in force in the bus (superseded, past its until, or never imported); no shard issued under it`)
    return 1
  }
  const by = issuerOf(deps, byArg)
  if (by === null)
    return 1
  const id = deps.uuid()
  const ts = deps.now().toISOString()
  const names = target.run === null ? { ...(target.card === null ? {} : { card: target.card }), ...(target.pr === null ? {} : { pr: target.pr }) } : { run: target.run }
  deps.record({ ts, type: SHARD_ISSUED, actor: 'owner', cardId: target.card, pr: target.pr, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by, run: target.run, ...(under === null ? {} : { under }) }, legacy: false })
  deps.append(path.join(deps.handoffDir, GHOST_JOURNAL), `${JSON.stringify({ event: SHARD_EVENT, id, by, ts, ...names, ...(under === null ? {} : { under }) })}\n`)
  deps.out(`${PREFIX}shard ${id} issued by ${by} for ${coveredBy(target, id)}${under === null ? '' : `, under D-${under} while it is in force: owner_by_risk, R1 and security-invariants lift, the version pull request and a reserved card do not`}`)
  return 0
}

export function recordInBus(event: BusEvent): void {
  const db = openBus(defaultBusPath())
  try {
    appendEvent(db, event)
  }
  finally {
    db.close()
  }
}

function realDeps(): ShardDeps {
  return {
    cwd: process.cwd(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    record: recordInBus,
    activeWindows: (now) => {
      const db = openBus(defaultBusPath())
      try {
        return activeWindowShards(db, now)
      }
      finally {
        db.close()
      }
    },
    inForce: (decisionId, now) => {
      const db = openBus(defaultBusPath())
      try {
        return decisionsInForceAt(db, now).some(decision => decision.decisionId === decisionId)
      }
      finally {
        db.close()
      }
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
