import type { DatabaseSync } from 'node:sqlite'
import type { EventPayload } from '../core/events.js'
import type { Projections } from '../core/reducer.js'
import type { BgResult, DetachedLaunch } from './bg.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { backupsDirOf, BUS_FILE, busDirOf } from '../core/bus-path.js'
import { appendEvent, BUSY_TIMEOUT_MS, openOwnerWait } from '../core/db.js'
import { BUS_HEAL_HELD, BUS_HEALED } from '../core/events.js'
import { reduce } from '../core/reducer.js'
import { openDatabase } from '../core/sqlite.js'
import { WATERMARKS } from '../core/watermark.js'
import { PREFIX } from './bg.js'
import { backupInto } from './bus-snapshot.js'

export const CORRUPT_SIGNATURE = /SQLITE_CORRUPT|database disk image is malformed|errcode:?\s*11\b/
export const NODES_RECORD = 'bus-nodes.json'
export const HEAL_FLAG = 'bus-heal.stop'
export const CONTROL_FILE = 'control.json'
export const HEAL_ACTOR = 'policy'
export const HEAL_WAIT_MS = 5 * 60_000
export const NODE_STOP_WAIT_MS = 10_000
export const NODE_STOP_POLL_MS = 100
const INTEGRITY_OK = 'ok'
const INTERRUPTED_HEAL = 'a heal that stopped the nodes did not finish'
const BROKEN_SHOWN = 20
const READ_CHUNK = 64 * 1024

export class CorruptionWatch {
  private readonly offsets = new Map<string, number>()

  constructor(private readonly files: readonly string[]) {
    for (const file of files)
      this.offsets.set(file, sizeOf(file))
  }

  seen(lines: readonly string[]): string | null {
    const fromLines = lines.find(line => CORRUPT_SIGNATURE.test(line))
    let found = fromLines ?? null
    for (const file of this.files) {
      const appended = this.appendedTo(file)
      found ??= appended.split('\n').find(line => CORRUPT_SIGNATURE.test(line)) ?? null
    }
    return found
  }

  private appendedTo(file: string): string {
    const size = sizeOf(file)
    const from = Math.min(this.offsets.get(file) ?? 0, size)
    this.offsets.set(file, size)
    if (size <= from)
      return ''
    const fd = openSync(file, 'r')
    try {
      const length = Math.min(size - from, READ_CHUNK)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    }
    finally {
      closeSync(fd)
    }
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  }
  catch {
    return 0
  }
}

export interface RecordedNode {
  script: string
  pid: number
  bus: string
}

interface HealFlag {
  state: 'healing' | 'held'
  since: string
  question?: string
  backup?: string | null
}

export interface NodeControl {
  stop: () => Promise<string[]>
  stillRunning: () => string[]
  stoppedSince: () => Date | null
  hold: (question: string, backup: string | null) => void
  restart: () => string[]
  held: () => boolean
  heldForOwner: () => boolean
}

export interface ProcessSignals {
  signal: (pid: number, name: NodeJS.Signals) => void
  runsNodeOfThisBus: (pid: number, script: string) => boolean
  runningOnThisBus: () => string[]
  pause: (ms: number) => Promise<unknown>
  now: () => Date
}

export class RecordedNodes implements NodeControl {
  private readonly busDir: string

  constructor(private readonly busPath: string, private readonly signals: ProcessSignals) {
    this.busDir = busDirOf(busPath)
  }

  started(launch: DetachedLaunch, result: BgResult): BgResult {
    const pid = Number(result.stdout[0])
    if (result.exitCode === 0 && Number.isSafeInteger(pid) && pid > 0)
      this.write([...this.record().filter(node => node.script !== launch.script), { script: launch.script, pid, bus: path.resolve(this.busPath) }])
    return result
  }

  ownNodes(): RecordedNode[] {
    const own = path.resolve(this.busPath)
    return this.record().filter(node => path.resolve(node.bus) === own)
  }

  async stop(): Promise<string[]> {
    this.writeFlag({ state: 'healing', since: (this.stoppedSince() ?? this.signals.now()).toISOString() })
    const recorded = this.ownNodes().filter(node => node.pid !== process.pid)
    const nodes = recorded.filter(node => this.stillTheNode(node))
    const stale = recorded.filter(node => !nodes.includes(node))
    this.write(this.record().filter(node => !stale.some(gone => gone.pid === node.pid && gone.script === node.script)))
    for (const node of nodes)
      this.signals.signal(node.pid, 'SIGTERM')
    for (let waited = 0; waited < NODE_STOP_WAIT_MS && nodes.some(node => this.stillTheNode(node)); waited += NODE_STOP_POLL_MS)
      await this.signals.pause(NODE_STOP_POLL_MS)
    const left = nodes.filter(node => this.stillTheNode(node))
    for (const node of left)
      this.signals.signal(node.pid, 'SIGKILL')
    const named = nodes.map(node => `${node.script} (pid ${node.pid})`).join(', ') || 'none running'
    return [
      `${PREFIX}stopped the nodes of ${this.busPath} by their process record and the stop flag ${this.flagFile()}: ${named}${left.length === 0 ? '' : `; killed after ${NODE_STOP_WAIT_MS / 1000}s: ${left.map(node => node.pid).join(', ')}`}`,
      ...stale.length === 0 ? [] : [`${PREFIX}dropped from the process record, gone or no longer a node of this bus, and not signalled: ${stale.map(node => `${node.script} (pid ${node.pid})`).join(', ')}`],
    ]
  }

  stillRunning(): string[] {
    return this.signals.runningOnThisBus()
  }

  stoppedSince(): Date | null {
    const flag = this.flag()
    return flag?.state === 'healing' ? new Date(flag.since) : null
  }

  private stillTheNode(node: RecordedNode): boolean {
    return this.signals.runsNodeOfThisBus(node.pid, node.script)
  }

  hold(question: string, backup: string | null): void {
    this.writeFlag({ state: 'held', since: this.signals.now().toISOString(), question, backup })
  }

  restart(): string[] {
    rmSync(this.flagFile(), { force: true })
    return [`${PREFIX}the stop flag ${this.flagFile()} is removed; the supervisor starts the switched-on nodes of ${this.busPath} again`]
  }

  held(): boolean {
    return existsSync(this.flagFile())
  }

  heldForOwner(): boolean {
    return this.flag()?.state === 'held'
  }

  flagFile(): string {
    return path.join(this.busDir, HEAL_FLAG)
  }

  private flag(): HealFlag | null {
    try {
      return JSON.parse(readFileSync(this.flagFile(), 'utf8')) as HealFlag
    }
    catch {
      return null
    }
  }

  private writeFlag(flag: HealFlag): void {
    mkdirSync(this.busDir, { recursive: true })
    writeFileSync(this.flagFile(), `${JSON.stringify(flag)}\n`)
  }

  private record(): RecordedNode[] {
    try {
      const nodes = JSON.parse(readFileSync(path.join(this.busDir, NODES_RECORD), 'utf8')) as unknown
      return Array.isArray(nodes) ? nodes.filter(isRecordedNode) : []
    }
    catch {
      return []
    }
  }

  private write(nodes: RecordedNode[]): void {
    mkdirSync(this.busDir, { recursive: true })
    writeFileSync(path.join(this.busDir, NODES_RECORD), `${JSON.stringify(nodes)}\n`)
  }
}

function isRecordedNode(value: unknown): value is RecordedNode {
  const node = value as Partial<RecordedNode> | null
  return typeof node?.script === 'string' && typeof node.pid === 'number' && Number.isSafeInteger(node.pid) && node.pid > 0 && typeof node.bus === 'string'
}

export interface EventsControl {
  maxId: number
  count: number
  digest: string
}

const EVENT_ROWS = 'SELECT id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy FROM events NOT INDEXED WHERE id <= ? ORDER BY id'
const DUPLICATE_KEYS = 'SELECT dedupe_key FROM events NOT INDEXED GROUP BY dedupe_key HAVING count(*) > 1 LIMIT 1'

export function eventsControl(db: DatabaseSync, throughId = Number.MAX_SAFE_INTEGER): EventsControl {
  const hash = createHash('sha256')
  let maxId = 0
  let count = 0
  for (const row of db.prepare(EVENT_ROWS).iterate(throughId)) {
    hash.update(`${JSON.stringify(Object.values(row))}\n`)
    maxId = Math.max(maxId, Number(row.id))
    count += 1
  }
  return { maxId, count, digest: hash.digest('hex') }
}

export function integrityOf(db: DatabaseSync): string[] {
  return (db.prepare(`PRAGMA integrity_check(${BROKEN_SHOWN})`).all() as { integrity_check: string }[]).map(row => row.integrity_check)
}

function maxEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events NOT INDEXED').get() as { id: number }).id)
}

export function laggingWatermarks(db: DatabaseSync): string[] {
  const through = maxEventId(db)
  const reduced = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  const rows = db.prepare(`SELECT projection, through_event_id FROM ${WATERMARKS} ORDER BY projection`).all() as { projection: string, through_event_id: number }[]
  return [
    ...reduced === through ? [] : [`user_version ${reduced}`],
    ...rows.filter(row => Number(row.through_event_id) !== through).map(row => `${row.projection} ${row.through_event_id}`),
  ].map(lag => `${lag} ≠ max(id) ${through}`)
}

export interface HealParts {
  busPath: string
  nodes: NodeControl
  now: () => Date
  projections: Projections
}

export type HealOutcome
  = | { kind: 'deferred', lines: string[] }
    | { kind: 'healed', backup: string, broken: string[], steps: string[], lines: string[] }
    | { kind: 'held', backup: string | null, question: string, lines: string[] }

class HealStepFailed extends Error {}

function stampOf(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function step<T>(name: string, work: () => T): T {
  try {
    return work()
  }
  catch (error) {
    if (error instanceof HealStepFailed)
      throw error
    throw new HealStepFailed(`${name} failed: ${errorText(error)}`)
  }
}

function demand(ok: boolean, failure: string): void {
  if (!ok)
    throw new HealStepFailed(failure)
}

async function backedUp(busPath: string, at: Date): Promise<string> {
  const dir = path.join(backupsDirOf(busPath), stampOf(at))
  try {
    await backupInto(busPath, path.join(dir, BUS_FILE))
  }
  catch (error) {
    throw new HealStepFailed(`the backup into ${dir} through the sqlite backup API failed: ${errorText(error)}`)
  }
  return dir
}

interface BackupReading {
  control: EventsControl
  broken: string[]
}

function readBackup(dir: string): BackupReading {
  const copy = openDatabase(path.join(dir, BUS_FILE), { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const control = step('reading the events table of the backup whole NOT INDEXED', () => eventsControl(copy))
    writeFileSync(path.join(dir, CONTROL_FILE), `${JSON.stringify({ max_id: control.maxId, count: control.count, digest: control.digest })}\n`)
    const duplicate = step('looking for a duplicate dedupe_key', () => copy.prepare(DUPLICATE_KEYS).get() as { dedupe_key: string } | undefined)
    demand(duplicate === undefined, `the events table holds the dedupe_key ${duplicate?.dedupe_key} twice, so REINDEX cannot rebuild its unique index`)
    return { control, broken: integrityOf(copy).filter(line => line !== INTEGRITY_OK) }
  }
  finally {
    copy.close()
  }
}

function repair(live: DatabaseSync, control: EventsControl, reduceBus: (db: DatabaseSync) => void): string[] {
  step('REINDEX events', () => live.exec('REINDEX events'))
  step('VACUUM', () => live.exec('VACUUM'))
  const integrity = step('pragma integrity_check', () => integrityOf(live))
  demand(integrity.length === 1 && integrity[0] === INTEGRITY_OK, `pragma integrity_check is not ok after REINDEX and VACUUM: ${integrity.join('; ')}`)
  const after = step('reading the events back', () => eventsControl(live, control.maxId))
  demand(after.count === control.count && after.maxId === control.maxId && after.digest === control.digest, `the events after the repair are not the events of the backup: ${after.count} through ${after.maxId}, the backup holds ${control.count} through ${control.maxId}`)
  step('bus:reduce', () => reduceBus(live))
  const lagging = laggingWatermarks(live)
  demand(lagging.length === 0, `the projection watermarks are not at max(id) after bus:reduce: ${lagging.join(', ')}`)
  return ['REINDEX events', 'VACUUM', 'integrity_check ok', `${control.count} events in place through ${control.maxId}`, 'bus:reduce', 'watermarks at max(id)']
}

function recordHealed(live: DatabaseSync, at: string, payload: EventPayload<typeof BUS_HEALED>, reduceBus: (db: DatabaseSync) => void): void {
  appendEvent(live, { ts: at, type: BUS_HEALED, actor: HEAL_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${BUS_HEALED}:${at}`, payload, legacy: false })
  reduceBus(live)
}

export function healQuestion(busPath: string, failure: string, backup: string | null, flag: string): string {
  return `question: the bus ${busPath} was not healed (${failure}); its nodes stay stopped${backup === null ? '' : ` and the backup is kept in ${backup}`}. Decide how to repair it by hand (never .recover, it can lose events), then remove ${flag} so the supervisor starts the nodes again`
}

function recordHeld(busPath: string, at: string, failure: string, backup: string | null, question: string): string[] {
  let live: DatabaseSync | null = null
  try {
    live = openDatabase(busPath, { timeout: BUSY_TIMEOUT_MS })
    appendEvent(live, { ts: at, type: BUS_HEAL_HELD, actor: HEAL_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${BUS_HEAL_HELD}:${at}`, payload: { failure, backup }, legacy: false })
    openOwnerWait(live, at, HEAL_ACTOR, { need: 'decision', text: question })
    return []
  }
  catch (error) {
    return [`${PREFIX}the broken bus could not take ${BUS_HEAL_HELD} or the owner wait (${errorText(error)}); the question stands in this log and in the stop flag`]
  }
  finally {
    live?.close()
  }
}

export async function healBus(parts: HealParts, cause: string): Promise<HealOutcome> {
  const { busPath, nodes } = parts
  const reduceBus = (db: DatabaseSync): void => void reduce(db, 'pending', parts.projections)
  const at = parts.now()
  const lines = [`${PREFIX}SQLITE_CORRUPT on ${busPath}: ${cause.trim()}; healing it`, ...await nodes.stop()]
  const unrecorded = nodes.stillRunning()
  const waitedMs = at.getTime() - (nodes.stoppedSince() ?? at).getTime()
  if (unrecorded.length > 0 && waitedMs < HEAL_WAIT_MS)
    return { kind: 'deferred', lines: [...lines, `${PREFIX}bus processes outside the process record still run on ${busPath}: ${unrecorded.join(', ')}; nothing is repaired while they hold it, the supervisor stops them as switched off and the heal retries on the next tick`] }
  let backup: string | null = null
  const live = openDatabase(busPath, { timeout: BUSY_TIMEOUT_MS })
  try {
    demand(unrecorded.length === 0, `bus processes outside the process record still run on it after ${Math.round(waitedMs / 60_000)} min: ${unrecorded.join(', ')}`)
    backup = await backedUp(busPath, at)
    const { control, broken } = readBackup(backup)
    lines.push(`${PREFIX}backed up into ${backup} through the sqlite backup API: max(id) ${control.maxId}, count(*) ${control.count}`)
    const steps = broken.length === 0 ? ['integrity_check ok on the backup; nothing to repair'] : repair(live, control, reduceBus)
    recordHealed(live, at.toISOString(), { backup, max_id: control.maxId, count: control.count, broken, steps }, reduceBus)
    return { kind: 'healed', backup, broken, steps, lines: [...lines, `${PREFIX}healed ${busPath}: ${broken.length === 0 ? 'nothing was broken' : `broken: ${broken.join('; ')}`}; done: ${steps.join(' → ')}`, ...nodes.restart()] }
  }
  catch (error) {
    live.close()
    const failure = error instanceof HealStepFailed ? error.message : `the heal failed: ${errorText(error)}`
    const question = healQuestion(busPath, failure, backup, path.join(busDirOf(busPath), HEAL_FLAG))
    nodes.hold(question, backup)
    return { kind: 'held', backup, question, lines: [...lines, ...recordHeld(busPath, at.toISOString(), failure, backup, question), question] }
  }
  finally {
    if (live.isOpen)
      live.close()
  }
}

export interface HealerParts extends HealParts {
  watch: CorruptionWatch
}

export class BusHealer {
  constructor(private readonly parts: HealerParts) {}

  async step(lines: readonly string[]): Promise<string[]> {
    if (this.parts.nodes.heldForOwner())
      return []
    const cause = this.parts.nodes.held() ? INTERRUPTED_HEAL : this.parts.watch.seen(lines)
    if (cause === null)
      return []
    try {
      return (await healBus(this.parts, cause)).lines
    }
    catch (error) {
      return [`${PREFIX}healing ${this.parts.busPath} failed before it began: ${errorText(error)}; tried again on the next SQLITE_CORRUPT`]
    }
  }
}
