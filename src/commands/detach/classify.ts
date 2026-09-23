import type { AttachRecord } from '../attach/record.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { sha256 } from '../../manifest.js'

export type FileClass = 'adopted' | 'absent' | 'changed' | 'remove'

export interface Classified {
  target: string
  kind: FileClass
}

function classOf(root: string, target: string, recorded: string, tracked: Set<string>): FileClass {
  if (tracked.has(target))
    return 'adopted'
  const absolute = path.join(root, target)
  if (!existsSync(absolute))
    return 'absent'
  if (sha256(readFileSync(absolute, 'utf8')) !== recorded)
    return 'changed'
  return 'remove'
}

export function classifyRecordedFiles(root: string, record: AttachRecord, tracked: Set<string>): Classified[] {
  return Object.entries(record.files).map(([target, recorded]) => ({ target, kind: classOf(root, target, recorded, tracked) }))
}

export function ofKind(classified: Classified[], kind: FileClass): string[] {
  return classified.filter(entry => entry.kind === kind).map(entry => entry.target)
}
