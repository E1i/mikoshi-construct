import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

export const MACHINE_DIR_VARIABLE = 'CONSTRUCT_MACHINE_DIR'
export const MACHINE_LIMIT_FILE = 'limit.json'
export const MACHINE_POLL_MS = 30_000

const CORES_PER_DEFAULT_SESSION = 4
const DEFAULT_LOAD_PER_CORE = 1
const CLAIM_PREFIX = 'claim-'
const WAIT_PREFIX = 'wait-'
const RECORD_SUFFIX = '.json'
const KEY_LENGTH = 24

export type MachineRole = 'launch' | 'answer' | 'review'

export interface MachineClaimant {
  bus: string
  role: MachineRole
  cardId: number
}

export interface MachineProcess {
  pid: number
  pgid?: number
  session?: string
}

export type MachineRecord = MachineClaimant & MachineProcess

export interface MachineWaiter extends MachineRecord {
  since: string
}

export interface LoadReading {
  busy: number
  cores: number
}

export interface MachineLoad {
  read: () => LoadReading
}

export const MEASURED_LOAD: MachineLoad = { read: () => ({ busy: os.loadavg()[0] ?? 0, cores: os.availableParallelism() }) }

export function idleLoad(cores: number): MachineLoad {
  return { read: () => ({ busy: 0, cores }) }
}

export function freeCores(reading: LoadReading): number {
  return Math.max(0, reading.cores - Math.ceil(reading.busy))
}

export interface MachineHold {
  live: number
  limit: number
  load?: LoadReading
}

export type MachineClaim = { kind: 'claimed' } | { kind: 'refused', hold: MachineHold }

export type SessionLive = (record: MachineRecord) => boolean

export type ProcessExists = (pid: number) => boolean

export function sessionLiveness(exists: ProcessExists): SessionLive {
  return record => exists(record.pgid ?? record.pid)
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch {
    return null
  }
}

function writeAtomically(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const staged = `${file}.${process.pid}.tmp`
  writeFileSync(staged, JSON.stringify(value))
  renameSync(staged, file)
}

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true })
  }
  catch {}
}

function defaultSessionLimit(cores: number): number {
  return Math.max(1, Math.floor(cores / CORES_PER_DEFAULT_SESSION))
}

interface LimitFile { sessions?: unknown, loadPerCore?: unknown }

export function setMachineLimit(dir: string, sessions: number, loadPerCore?: number): void {
  writeAtomically(path.join(dir, MACHINE_LIMIT_FILE), { sessions, ...(loadPerCore === undefined ? {} : { loadPerCore }) })
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export class MachineSessions {
  constructor(private readonly dir: string, private readonly isLive: SessionLive, private readonly cores: number, private readonly now: () => Date = () => new Date(), private readonly load: MachineLoad = idleLoad(cores)) {}

  limit(): number {
    const sessions = this.limitFile()?.sessions
    return typeof sessions === 'number' && Number.isInteger(sessions) && sessions > 0 ? sessions : defaultSessionLimit(this.cores)
  }

  overload(): LoadReading | null {
    const loadPerCore = this.limitFile()?.loadPerCore
    const reading = this.load.read()
    return reading.busy >= reading.cores * (positive(loadPerCore) ? loadPerCore : DEFAULT_LOAD_PER_CORE) ? reading : null
  }

  live(): number {
    return this.liveClaims().length
  }

  held(): MachineHold | null {
    const limit = this.limit()
    const live = this.live()
    const load = this.overload()
    if (load !== null)
      return { live, limit, load }
    return live >= limit ? { live, limit } : null
  }

  free(): number {
    return this.overload() === null ? Math.max(0, this.limit() - this.live()) : 0
  }

  claim(claimant: MachineClaimant, pid: number = process.pid): MachineClaim {
    try {
      return this.claimRecorded(claimant, pid)
    }
    catch {
      return { kind: 'claimed' }
    }
  }

  started(claimant: MachineClaimant, session: MachineProcess): void {
    try {
      writeAtomically(this.fileOf(CLAIM_PREFIX, claimant), { ...claimant, pid: session.pid, pgid: session.pgid, session: session.session } satisfies MachineRecord)
    }
    catch {}
  }

  release(claimant: MachineClaimant): void {
    removeQuietly(this.fileOf(CLAIM_PREFIX, claimant))
    removeQuietly(this.fileOf(WAIT_PREFIX, claimant))
  }

  waits(claimant: MachineClaimant, pid: number = process.pid): void {
    const file = this.fileOf(WAIT_PREFIX, claimant)
    if (readJson<MachineWaiter>(file) !== null)
      return
    try {
      writeAtomically(file, { ...claimant, pid, since: this.now().toISOString() } satisfies MachineWaiter)
    }
    catch {}
  }

  waiting(bus: string): MachineWaiter[] {
    return this.records<MachineWaiter>(WAIT_PREFIX).filter(waiter => waiter.bus === bus && this.isLive({ bus: waiter.bus, role: waiter.role, cardId: waiter.cardId, pid: waiter.pid }))
  }

  private claimRecorded(claimant: MachineClaimant, pid: number): MachineClaim {
    const file = this.fileOf(CLAIM_PREFIX, claimant)
    const own = readJson<MachineRecord>(file)
    if (own !== null && this.isLive(own)) {
      removeQuietly(this.fileOf(WAIT_PREFIX, claimant))
      return { kind: 'claimed' }
    }
    this.sweep()
    const limit = this.limit()
    const before = this.live()
    const load = this.overload()
    if (load !== null)
      return { kind: 'refused', hold: { live: before, limit, load } }
    if (before >= limit)
      return { kind: 'refused', hold: { live: before, limit } }
    writeAtomically(file, { ...claimant, pid } satisfies MachineRecord)
    const after = this.live()
    if (after > limit) {
      removeQuietly(file)
      return { kind: 'refused', hold: { live: after - 1, limit } }
    }
    removeQuietly(this.fileOf(WAIT_PREFIX, claimant))
    return { kind: 'claimed' }
  }

  private limitFile(): LimitFile | null {
    return readJson<LimitFile>(path.join(this.dir, MACHINE_LIMIT_FILE))
  }

  private sweep(): void {
    for (const name of this.names(CLAIM_PREFIX)) {
      const record = readJson<MachineRecord>(path.join(this.dir, name))
      if (record !== null && !this.isLive(record))
        removeQuietly(path.join(this.dir, name))
    }
    for (const name of this.names(WAIT_PREFIX)) {
      const record = readJson<MachineRecord>(path.join(this.dir, name))
      if (record !== null && !this.isLive({ bus: record.bus, role: record.role, cardId: record.cardId, pid: record.pid }))
        removeQuietly(path.join(this.dir, name))
    }
  }

  private liveClaims(): MachineRecord[] {
    return this.records<MachineRecord>(CLAIM_PREFIX).filter(record => this.isLive(record))
  }

  private records<T>(prefix: string): T[] {
    return this.names(prefix).flatMap((name) => {
      const record = readJson<T>(path.join(this.dir, name))
      return record === null ? [] : [record]
    })
  }

  private names(prefix: string): string[] {
    try {
      return readdirSync(this.dir).filter(name => name.startsWith(prefix) && name.endsWith(RECORD_SUFFIX))
    }
    catch {
      return []
    }
  }

  private fileOf(prefix: string, claimant: MachineClaimant): string {
    const key = createHash('sha256').update(`${claimant.bus}\0${claimant.role}\0${claimant.cardId}`).digest('hex').slice(0, KEY_LENGTH)
    return path.join(this.dir, `${prefix}${key}${RECORD_SUFFIX}`)
  }
}

export function machineDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env[MACHINE_DIR_VARIABLE] ?? path.join(home, '.construct', 'machine')
}

export function machineSessions(exists: ProcessExists, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), load: MachineLoad = MEASURED_LOAD): MachineSessions {
  return new MachineSessions(machineDir(env, home), sessionLiveness(exists), os.availableParallelism(), () => new Date(), load)
}

export function busNameOf(busPath: string): string {
  try {
    return realpathSync(busPath)
  }
  catch {
    return path.resolve(busPath)
  }
}

export function busNameOfDb(db: DatabaseSync): string {
  const location = db.location()
  return location === null ? '' : busNameOf(location)
}

export function machineHoldLine(hold: MachineHold): string {
  if (hold.load !== undefined)
    return `machine overloaded: load ${hold.load.busy.toFixed(1)} on ${hold.load.cores} cores across every process on this machine; the start waits in the queue until the load falls`
  return `machine session limit: ${hold.live} of ${hold.limit} live sessions across every bus on this machine; the start waits until one ends`
}

export interface MachineGate {
  start: (cardId: number, keep: () => boolean) => Promise<boolean>
  release: (cardId: number) => void
}

export interface MachineGateParts {
  machine: MachineSessions
  pause?: (ms: number) => Promise<unknown>
  say?: (line: string) => void
}

export function machineGate(bus: string, role: MachineRole, parts: MachineGateParts): MachineGate {
  const { machine } = parts
  const pause = parts.pause ?? sleep
  const say = parts.say ?? ((line: string) => console.error(line))
  const claimantOf = (cardId: number): MachineClaimant => ({ bus, role, cardId })
  const stillWanted = (keep: () => boolean): boolean => {
    try {
      return keep()
    }
    catch (error) {
      say(`the ${role} session could not read whether its task is still held, it goes on waiting: ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }
  return {
    start: async (cardId, keep) => {
      const claimant = claimantOf(cardId)
      let told = ''
      for (;;) {
        const claim = machine.claim(claimant)
        if (claim.kind === 'claimed')
          return true
        machine.waits(claimant)
        const line = `#${cardId} ${role}: ${machineHoldLine(claim.hold)}`
        if (line !== told)
          say(line)
        told = line
        if (!stillWanted(keep)) {
          machine.release(claimant)
          return false
        }
        await pause(MACHINE_POLL_MS)
      }
    },
    release: cardId => machine.release(claimantOf(cardId)),
  }
}
