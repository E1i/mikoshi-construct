import type { BusEvent } from '../core/db.js'
import type { WindowScope, WindowShard } from './shards.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendEvent, defaultBusPath, openBus } from '../core/db.js'
import { activeWindowShards, decisionsInForceAt, isWindowScope, WINDOW_SHARD_HOURS, windowShardEnded } from './shards.js'
import { SHARD_ISSUED, SHARD_REVOKED } from '../core/events.js'

export const PREFIX = '[shard] '
export const USAGE = 'usage: pnpm shard --card <n> | --pr <n> [--under D-<id>] | --window [--hours <n>] [--scope merge|merge+decisions] | --stop [--by <name>]'
const VALUED_FLAGS = ['--by', '--card', '--pr', '--under', '--hours', '--scope']
const WINDOW_FLAG = '--window'
const STOP_FLAG = '--stop'
const DECISION_ID = /^D-([1-9]\d*)$/
const HOUR_MS = 3_600_000

export interface ShardDeps {
  record: (event: BusEvent) => void
  activeWindows: (now: Date) => WindowShard[]
  inForce: (decisionId: number, now: Date) => boolean
  now: () => Date
  uuid: () => string
  by: () => string
  out: (line: string) => void
  err: (line: string) => void
}

interface ShardTarget {
  card: number | null
  pr: number | null
}

function positiveInteger(value: string | undefined): number | null {
  const number = Number(value)
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : null
}

function targetOf(rest: string[], card: string | undefined, pr: string | undefined): ShardTarget | null {
  if (card === undefined && pr === undefined)
    return null
  const target = { card: positiveInteger(card), pr: positiveInteger(pr) }
  if (rest.length > 0 || (card !== undefined && target.card === null) || (pr !== undefined && target.pr === null))
    return null
  return target
}

function coveredBy(target: ShardTarget): string {
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
  const target = targetOf(rest, cardArg, prArg)
  const under = underArg === undefined ? null : Number(DECISION_ID.exec(underArg)?.[1] ?? Number.NaN)
  if (target === null || Number.isNaN(under) || hoursArg !== undefined || scopeArg !== undefined)
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
  deps.record({ ts, type: SHARD_ISSUED, actor: 'owner', cardId: target.card, pr: target.pr, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by, run: null, ...(under === null ? {} : { under }) }, legacy: false })
  deps.out(`${PREFIX}shard ${id} issued by ${by} for ${coveredBy(target)}${under === null ? '' : `, under D-${under} while it is in force: owner_by_risk, R1 and security-invariants lift, the version pull request and a reserved card do not`}`)
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
