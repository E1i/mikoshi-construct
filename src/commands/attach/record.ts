import type { ServeRecord } from '../../presets/index.js'
import type { FactoryBeside } from './beside.js'
import type { SettingsHook } from './settings.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const ATTACH_RECORD_FILE = '.construct/attach.json'
export const ATTACH_LEDGER_DIR = '.construct'
export const ATTACH_RECORD_VERSION = 4
export const NO_HARNESS = 'none'

export type PushPolicy = 'none' | 'bus'

export const DEFAULT_PUSH_POLICY: PushPolicy = 'none'
export const ATTACH_SERVE_READY_TIMEOUT_MS = 30_000

export type AttachHarness = { command: string, job?: string } | typeof NO_HARNESS

export interface AttachRecord {
  recordVersion: number
  construct: string
  attachedVersion?: string
  attachedAt: string
  harness: AttachHarness
  files: Record<string, string>
  directories: string[]
  excludeCreated: boolean
  ledgerCreated?: boolean
  ledgerHeld?: string[]
  browserHeld?: string[]
  excludeSeparator: number
  settingsHook?: SettingsHook
  lanes?: number
  factoryBeside?: FactoryBeside
  push?: PushPolicy
  serve?: ServeRecord
}

function isHttpUrl(url: string): boolean {
  return URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)
}

export function serveFromFlags(command: string | undefined, url: string | undefined): ServeRecord | undefined {
  if (command == null && url == null)
    return undefined
  if (command == null || url == null)
    throw new Error(`--serve and --serve-url go together: ${command == null ? '--serve-url' : '--serve'} was given without ${command == null ? '--serve' : '--serve-url'}; nothing was written`)
  if (command.trim() === '')
    throw new Error('--serve needs the command that brings the server up; nothing was written')
  if (!isHttpUrl(url))
    throw new Error(`--serve-url needs an http or https URL, not "${url}"; nothing was written`)
  return { command, url, readyTimeoutMs: ATTACH_SERVE_READY_TIMEOUT_MS }
}

export function readAttachRecord(root: string): AttachRecord | null {
  const file = path.join(root, ATTACH_RECORD_FILE)
  if (!existsSync(file))
    return null
  return JSON.parse(readFileSync(file, 'utf8')) as AttachRecord
}

export type CarriersReading = 'current' | 'stale' | 'ahead' | 'unknown'

export function attachedVersionOf(record: AttachRecord): string | null {
  return typeof record.attachedVersion === 'string' ? record.attachedVersion : null
}

export function carriersReading(attached: string | null, installed: string): CarriersReading {
  if (attached == null)
    return 'unknown'
  if (attached === installed)
    return 'current'
  return attached.localeCompare(installed, undefined, { numeric: true }) > 0 ? 'ahead' : 'stale'
}

export function writeAttachRecord(root: string, record: AttachRecord): void {
  const file = path.join(root, ATTACH_RECORD_FILE)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}
