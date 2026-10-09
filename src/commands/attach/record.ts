import type { SettingsHook } from './settings.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const ATTACH_RECORD_FILE = '.construct/attach.json'
export const ATTACH_LEDGER_DIR = '.construct'
export const ATTACH_RECORD_VERSION = 3
export const NO_HARNESS = 'none'

export type AttachHarness = { command: string } | typeof NO_HARNESS

export interface AttachRecord {
  recordVersion: number
  construct: string
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
}

export function readAttachRecord(root: string): AttachRecord | null {
  const file = path.join(root, ATTACH_RECORD_FILE)
  if (!existsSync(file))
    return null
  return JSON.parse(readFileSync(file, 'utf8')) as AttachRecord
}

export function writeAttachRecord(root: string, record: AttachRecord): void {
  const file = path.join(root, ATTACH_RECORD_FILE)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}
