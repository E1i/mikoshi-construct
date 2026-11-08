import type { Refusal } from './sandbox-refusals.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { OsProcessTable, TECHNOLOGY_WORDS } from '../ports/process-table.js'
import { REFUSALS } from './sandbox-refusals.js'

export interface SandboxFailing { file: string, test: string, refused: Refusal }

export const SANDBOX_FAILING_LIST = path.join(import.meta.dirname, 'sandbox-failing.jsonl')

export function parseSandboxFailing(text: string): SandboxFailing[] {
  return text.split('\n').filter(line => line !== '').map((line, index) => {
    const entry = JSON.parse(line) as Partial<SandboxFailing>
    if (typeof entry.file !== 'string' || typeof entry.test !== 'string' || typeof entry.refused !== 'string' || !(entry.refused in REFUSALS))
      throw new Error(`sandbox-failing.jsonl line ${index + 1} names no file, test and known refusal: ${line}`)
    return { file: entry.file, test: entry.test, refused: entry.refused as Refusal }
  })
}

export const SANDBOX_FAILING: readonly SandboxFailing[] = parseSandboxFailing(readFileSync(SANDBOX_FAILING_LIST, 'utf8'))

const [, PROCESS_LISTING] = TECHNOLOGY_WORDS

export const CAPABILITIES = ['net-listen', PROCESS_LISTING, 'miko-session'] as const

export type Capability = typeof CAPABILITIES[number]

export type CapabilityProbes = Record<Capability, () => Promise<boolean>>

const DECLARED = /\[needs ([a-z-]+)\]/g

export function declaredCapabilities(testName: string): Capability[] {
  const named = [...testName.matchAll(DECLARED)].map(match => match[1]!)
  return CAPABILITIES.filter(capability => named.includes(capability))
}

async function listens(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function readsProcesses(): Promise<boolean> {
  return new OsProcessTable().snapshot().readable
}

async function writesSessionHome(): Promise<boolean> {
  try {
    const home = path.join(os.homedir(), '.construct')
    mkdirSync(home, { recursive: true })
    rmSync(mkdtempSync(path.join(home, 'capability-')), { recursive: true, force: true })
    return true
  }
  catch {
    return false
  }
}

export const SANDBOX_PROBES: CapabilityProbes = { 'net-listen': listens, [PROCESS_LISTING]: readsProcesses, 'miko-session': writesSessionHome }

export async function probeCapabilities(probes: CapabilityProbes = SANDBOX_PROBES): Promise<ReadonlySet<Capability>> {
  const found = await Promise.all(CAPABILITIES.map(async capability => [capability, await probes[capability]().catch(() => false)] as const))
  return new Set(found.filter(([, available]) => available).map(([capability]) => capability))
}

export interface NormFailure { key: string, missing: Capability[] }

export interface SandboxReading { norm: NormFailure[], real: string[] }

export function sandboxNorm(failed: readonly string[], available: ReadonlySet<Capability>): SandboxReading {
  const norm: NormFailure[] = []
  const real: string[] = []
  for (const key of failed) {
    const missing = declaredCapabilities(key).filter(capability => !available.has(capability))
    if (missing.length === 0)
      real.push(key)
    else
      norm.push({ key, missing })
  }
  return { norm, real }
}

export function normLine({ key, missing }: NormFailure): string {
  return `sandbox norm: no ${missing.join(', ')} — ${key}`
}
