import type { MutationLine } from './lines.js'
import type { MutationRecord } from './record.js'
import { Buffer } from 'node:buffer'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseMutationFile } from './lines.js'
import { isSafeId, mutationRecorded, readBaseline, sha256, writeCopy, writeMutationRecord } from './record.js'

export interface ApplyOptions {
  dir: string
  from: string
  id: string
}

export type ApplyRefusal
  = | 'no-baseline'
    | 'unsafe-id'
    | 'from-unreadable'
    | 'unknown-id'
    | 'duplicate-id'
    | 'malformed-line'
    | 'edit-line'
    | 'record-exists'
    | 'outside-dir'
    | 'file-missing'
    | 'changed-after-baseline'
    | 'find-count'

export type ApplyResult
  = | { status: 'applied', record: MutationRecord }
    | { status: 'refused', refusal: ApplyRefusal, detail: string }

function refused(refusal: ApplyRefusal, detail = ''): ApplyResult {
  return { status: 'refused', refusal, detail }
}

export function occurrences(haystack: Buffer, needle: Buffer): number {
  if (needle.length === 0)
    return Number.POSITIVE_INFINITY
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + 1)
  }
  return count
}

function lineFor(from: string, id: string): MutationLine | ApplyResult {
  let text: string
  try {
    text = readFileSync(from, 'utf8')
  }
  catch {
    return refused('from-unreadable', from)
  }
  const matching = parseMutationFile(text).filter(parsed => parsed.id === id)
  if (matching.length === 0)
    return refused('unknown-id', id)
  if (matching.length > 1)
    return refused('duplicate-id', String(matching.length))
  const [parsed] = matching
  if ('malformed' in parsed)
    return refused('malformed-line', parsed.malformed)
  return parsed.line
}

function targetIn(root: string, file: string): string | null {
  const target = path.resolve(root, file)
  const relative = path.relative(root, target)
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? null : target
}

function modifiedAt(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return null
  }
}

export function applyMutation(options: ApplyOptions): ApplyResult {
  const root = path.resolve(options.dir)
  const baseline = readBaseline(root)
  if (baseline == null)
    return refused('no-baseline')
  if (!isSafeId(options.id))
    return refused('unsafe-id', options.id)
  const line = lineFor(path.resolve(options.from), options.id)
  if ('status' in line)
    return line
  if (line.change.kind === 'edit')
    return refused('edit-line', line.change.prose)
  if (mutationRecorded(root, line.id))
    return refused('record-exists', line.id)
  const target = targetIn(root, line.file)
  if (target == null)
    return refused('outside-dir', line.file)
  const mtime = modifiedAt(target)
  if (mtime == null)
    return refused('file-missing', line.file)
  if (mtime > baseline.startTime)
    return refused('changed-after-baseline', line.file)

  const original = readFileSync(target)
  const find = Buffer.from(line.change.find, 'utf8')
  const count = occurrences(original, find)
  if (count !== 1)
    return refused('find-count', String(count))
  const at = original.indexOf(find)
  const mutated = Buffer.concat([original.subarray(0, at), Buffer.from(line.change.replace, 'utf8'), original.subarray(at + find.length)])

  const record: MutationRecord = {
    id: line.id,
    file: line.file,
    baselineSha: sha256(original),
    mutatedSha: sha256(mutated),
    appliedAt: Date.now(),
    originalMtimeMs: mtime,
    prediction: line.prediction,
    message: line.message,
  }
  writeCopy(root, line.id, original)
  writeMutationRecord(root, record)
  writeFileSync(target, mutated)
  return { status: 'applied', record }
}
