import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defaultBusPath } from '../core/bus-path.js'

export const HOST_FAULT_CODES = ['ENOENT', 'EAGAIN', 'EMFILE'] as const

export const HOST_DEGRADED = 'host-degraded'

export type HostFaultSource = 'os' | 'network' | 'github'

export interface HostFault {
  source: HostFaultSource
  detail: string
}

export interface Backoff {
  attempts: number
  firstMs: number
  sleep: (ms: number) => void
}

const OS_CODES: ReadonlySet<string> = new Set(HOST_FAULT_CODES)
const ALWAYS_HOST_CODES: ReadonlySet<string> = new Set(['EAGAIN', 'EMFILE'])
const OS_CALL = /^(?:spawn|uv_os_|getpwuid)/
const OS_CALL_IN_TEXT = /\buv_os_\w+ returned (?:ENOENT|EAGAIN|EMFILE)\b|\bspawn(?:Sync)? \S+ (?:ENOENT|EAGAIN|EMFILE)\b|\bEMFILE\b|too many open files|\bEAGAIN\b|resource temporarily unavailable/i
const NETWORK_FAILURE = /could not resolve host|failed to connect to|connection (?:timed out|reset|refused)|the remote end hung up unexpectedly|early eof|operation timed out|network is unreachable|temporary failure in name resolution/i
const GITHUB_SERVER_ERROR = /\bHTTP 5\d\d\b|\bstatus(?: code)?:? 5\d\d\b|returned error: 5\d\d\b|\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i
const HOUR_OF_TS = 13

function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms)
}

export const HOST_BACKOFF: Backoff = { attempts: 3, firstMs: 1_000, sleep: pauseSync }

export class HostFaultPersists extends Error {
  constructor(readonly fault: HostFault, readonly attempts: number) {
    super(`host fault after ${attempts} attempts (${fault.source}): ${fault.detail}`)
  }
}

function textOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const said = typeof stderr === 'string' || stderr instanceof Uint8Array ? String(stderr) : ''
  return `${error instanceof Error ? error.message : String(error)}\n${said}`
}

function osCodeOf(error: unknown): string | null {
  const shaped = error as { code?: unknown, syscall?: unknown, info?: { code?: unknown } } | null
  const code = typeof shaped?.info?.code === 'string' ? shaped.info.code : typeof shaped?.code === 'string' ? shaped.code : null
  if (code === null || !OS_CODES.has(code))
    return null
  const call = typeof shaped?.syscall === 'string' ? shaped.syscall : ''
  return ALWAYS_HOST_CODES.has(code) || OS_CALL.test(call) || shaped?.info !== undefined ? code : null
}

function lineSaying(text: string, pattern: RegExp): string {
  const lines = text.split('\n').map(each => each.trim()).filter(each => each !== '')
  return lines.find(each => pattern.test(each)) ?? lines[0] ?? ''
}

export function hostFaultInText(text: string): HostFault | null {
  if (OS_CALL_IN_TEXT.test(text))
    return { source: 'os', detail: lineSaying(text, OS_CALL_IN_TEXT) }
  if (GITHUB_SERVER_ERROR.test(text))
    return { source: 'github', detail: lineSaying(text, GITHUB_SERVER_ERROR) }
  if (NETWORK_FAILURE.test(text))
    return { source: 'network', detail: lineSaying(text, NETWORK_FAILURE) }
  return null
}

export function hostFaultOf(error: unknown): HostFault | null {
  if (error instanceof HostFaultPersists)
    return error.fault
  const code = osCodeOf(error)
  if (code !== null)
    return { source: 'os', detail: `${code}: ${textOf(error).trim().split('\n')[0] ?? ''}` }
  return hostFaultInText(textOf(error))
}

export function backoffDelay(backoff: Backoff, attempt: number): number {
  return backoff.firstMs * 2 ** attempt
}

export interface LastHostFailures {
  github: string | null
  dns: string | null
  getpwuid: string | null
}

type FailureVital = keyof LastHostFailures

const PASSWD_LOOKUP = /getpwuid|uv_os_get_passwd|userInfo/i
const FAILURES_FILE = 'host-failures.json'
const NO_FAILURES: LastHostFailures = { github: null, dns: null, getpwuid: null }

function vitalOf(fault: HostFault): FailureVital | null {
  if (fault.source === 'github')
    return 'github'
  if (fault.source === 'network')
    return 'dns'
  return PASSWD_LOOKUP.test(fault.detail) ? 'getpwuid' : null
}

function busFailuresFile(): string | null {
  try {
    return path.join(path.dirname(defaultBusPath()), FAILURES_FILE)
  }
  catch {
    return null
  }
}

export class HostFailureLog {
  constructor(private readonly file: () => string | null = busFailuresFile, private readonly now: () => Date = () => new Date()) {}

  notice(error: unknown): HostFault | null {
    const fault = hostFaultOf(error)
    if (fault !== null)
      this.record(fault)
    return fault
  }

  record(fault: HostFault): void {
    const vital = vitalOf(fault)
    const file = this.file()
    if (vital === null || file === null)
      return
    try {
      writeFileSync(file, `${JSON.stringify({ ...this.last(), [vital]: `${this.now().toISOString()} ${fault.detail}` })}\n`)
    }
    catch {}
  }

  last(): LastHostFailures {
    const file = this.file()
    if (file === null)
      return NO_FAILURES
    try {
      const read = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<FailureVital, unknown>>
      const said = (vital: FailureVital): string | null => typeof read[vital] === 'string' ? read[vital] : null
      return { github: said('github'), dns: said('dns'), getpwuid: said('getpwuid') }
    }
    catch {
      return NO_FAILURES
    }
  }
}

export const HOST_FAILURES = new HostFailureLog()

export function hostDegradedLine(cause: string): string {
  return `${HOST_DEGRADED}: ${cause}; this is the host, not a card: no card is stopped, no round is spent and no card wait opens, and every card retries once the host recovers`
}

export function hostAlarmKey(reason: string, cause: string, ts: string): string {
  return `${reason}:${cause}:${ts.slice(0, HOUR_OF_TS)}`
}
