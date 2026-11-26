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
const FIRST_SERVER_STATUS = 500
const LAST_SERVER_STATUS = 599

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

export function hostFaultInText(text: string): HostFault | null {
  const line = text.trim().split('\n').find(each => each.trim() !== '')?.trim() ?? text.trim()
  if (OS_CALL_IN_TEXT.test(text))
    return { source: 'os', detail: line }
  if (GITHUB_SERVER_ERROR.test(text))
    return { source: 'github', detail: line }
  if (NETWORK_FAILURE.test(text))
    return { source: 'network', detail: line }
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

export function githubStatusFault(status: number | null, detail: string): HostFault | null {
  return status !== null && status >= FIRST_SERVER_STATUS && status <= LAST_SERVER_STATUS ? { source: 'github', detail: `GitHub answered ${status}: ${detail}` } : null
}

export function backoffDelay(backoff: Backoff, attempt: number): number {
  return backoff.firstMs * 2 ** attempt
}

export function retryingHostFaults<T>(work: () => T, backoff: Backoff = HOST_BACKOFF): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return work()
    }
    catch (error) {
      const fault = hostFaultOf(error)
      if (fault === null)
        throw error
      if (attempt + 1 >= backoff.attempts)
        throw new HostFaultPersists(fault, attempt + 1)
      backoff.sleep(backoffDelay(backoff, attempt))
    }
  }
}

export function hostDegradedLine(cause: string): string {
  return `${HOST_DEGRADED}: ${cause}; this is the host, not a card: no card is stopped, no round is spent and no card wait opens, and every card retries once the host recovers`
}

export function hostDegradedKey(ts: string): string {
  return `${HOST_DEGRADED}:${ts.slice(0, 13)}`
}
