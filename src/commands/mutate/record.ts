import type { Buffer } from 'node:buffer'
import type { Prediction } from './lines.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MUTATIONS_DIR = '.construct/mutations'
export const BASELINE_FILE = `${MUTATIONS_DIR}/baseline.json`
const SAFE_ID = /^\w[\w.-]*$/

export interface BaselineRecord {
  startTime: number
  recordedAt: number
  tests: number
}

export interface MutationRecord {
  id: string
  file: string
  baselineSha: string
  mutatedSha: string
  appliedAt: number
  originalMtimeMs: number
  prediction: Prediction
  message: string | null
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && id !== 'baseline'
}

export function recordPath(id: string): string {
  return `${MUTATIONS_DIR}/${id}.json`
}

export function copyPath(id: string): string {
  return `${MUTATIONS_DIR}/${id}.orig`
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  }
  catch {
    return null
  }
}

function writeJson(root: string, relative: string, value: unknown): void {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readBaseline(root: string): BaselineRecord | null {
  const value = readJson(path.join(root, BASELINE_FILE))
  if (value == null || typeof value !== 'object' || typeof (value as BaselineRecord).startTime !== 'number')
    return null
  return value as BaselineRecord
}

export function writeBaseline(root: string, baseline: BaselineRecord): void {
  writeJson(root, BASELINE_FILE, baseline)
}

export function mutationRecorded(root: string, id: string): boolean {
  return existsSync(path.join(root, recordPath(id))) || existsSync(path.join(root, copyPath(id)))
}

export function readMutationRecord(root: string, id: string): MutationRecord | null {
  const value = readJson(path.join(root, recordPath(id)))
  if (value == null || typeof value !== 'object')
    return null
  const record = value as MutationRecord
  if (record.id !== id || typeof record.file !== 'string' || typeof record.mutatedSha !== 'string' || typeof record.appliedAt !== 'number')
    return null
  return record
}

export function writeMutationRecord(root: string, record: MutationRecord): void {
  writeJson(root, recordPath(record.id), record)
}

export function writeCopy(root: string, id: string, bytes: Uint8Array): void {
  const file = path.join(root, copyPath(id))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}

export function readCopy(root: string, id: string): Buffer | null {
  try {
    return readFileSync(path.join(root, copyPath(id)))
  }
  catch {
    return null
  }
}

export function forgetMutation(root: string, id: string): void {
  rmSync(path.join(root, recordPath(id)), { force: true })
  rmSync(path.join(root, copyPath(id)), { force: true })
}
