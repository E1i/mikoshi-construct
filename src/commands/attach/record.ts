import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const ATTACH_RECORD_FILE = '.construct/attach.json'
export const ATTACH_RECORD_VERSION = 1

export interface AttachRecord {
  recordVersion: number
  construct: string
  attachedAt: string
  harness: { command: string }
  files: Record<string, string>
  directories: string[]
  excludeCreated: boolean
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
