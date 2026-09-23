import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { IndexUnreadable } from './index-reader.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isBlockSeparator } from '../../materialize/strategies.js'
import { planExcludeRemoval, readExcludeBlockPaths } from '../attach/exclude.js'
import { ATTACH_RECORD_FILE, ATTACH_RECORD_VERSION, readAttachRecord } from '../attach/record.js'
import { classifyRecordedFiles, ofKind } from './classify.js'
import { readTrackedPaths } from './index-reader.js'
import { removeAttached } from './remove.js'

export type { IndexReading, IndexUnreadable } from './index-reader.js'
export { readTrackedPaths } from './index-reader.js'

export interface DetachOptions {
  dir: string
}

export type DetachRefusalReason = 'orphan-block' | 'record-version' | 'record-ahead' | 'separator' | 'separator-mismatch' | 'changed' | IndexUnreadable

export interface DetachResult {
  status: 'done' | 'nothing-attached' | 'refused'
  refusal?: DetachRefusalReason
  removed: string[]
}

const REFUSAL_LINE: Record<DetachRefusalReason, (lore: Lore, paths: string[]) => string> = {
  'orphan-block': lore => lore.detachRefusedOrphanBlock,
  'record-version': lore => lore.detachRefusedRecordVersion,
  'record-ahead': (lore, found) => lore.recordAhead(ATTACH_RECORD_FILE, 'recordVersion', Number(found[0]), ATTACH_RECORD_VERSION),
  'separator': lore => lore.detachRefusedSeparator,
  'separator-mismatch': lore => lore.detachRefusedSeparatorMismatch,
  'changed': (lore, paths) => lore.detachRefusedChanged(paths.length),
  'index-v4': lore => lore.detachRefusedIndexV4,
  'split-index': lore => lore.detachRefusedSplitIndex,
  'sparse-index': lore => lore.detachRefusedSparseIndex,
  'object-format': lore => lore.detachRefusedObjectFormat,
}

function refused(ui: Ui, reason: DetachRefusalReason, lines: string[] = []): DetachResult {
  ui.flatline(REFUSAL_LINE[reason](ui.lore, lines))
  for (const line of lines)
    ui.line(`    ${ui.theme.dim(line)}`)
  return { status: 'refused', refusal: reason, removed: [] }
}

function refusedAhead(ui: Ui, found: number): DetachResult {
  ui.flatline(REFUSAL_LINE['record-ahead'](ui.lore, [String(found)]))
  return { status: 'refused', refusal: 'record-ahead', removed: [] }
}

function onDiskLabel(ui: Ui, root: string, target: string): string {
  return `${target}  ${existsSync(path.join(root, target)) ? ui.lore.detachPresentOnDisk : ui.lore.detachAbsentOnDisk}`
}

export function runDetach(ui: Ui, options: DetachOptions): DetachResult {
  const root = path.resolve(options.dir)
  const record = readAttachRecord(root)
  const blockPaths = readExcludeBlockPaths(root)

  if (record == null && blockPaths.length === 0) {
    ui.line(ui.lore.detachNothingAttached)
    return { status: 'nothing-attached', removed: [] }
  }
  if (record == null)
    return refused(ui, 'orphan-block', blockPaths.map(target => onDiskLabel(ui, root, target)))
  const version: unknown = record.recordVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return refused(ui, 'record-version', [String(version)])
  if (version > ATTACH_RECORD_VERSION)
    return refusedAhead(ui, version)
  const separator = record.excludeSeparator
  if (!isBlockSeparator(separator))
    return refused(ui, 'separator', [String(separator)])
  const exclude = planExcludeRemoval(root, separator)
  if (exclude.kind === 'mismatch')
    return refused(ui, 'separator-mismatch')

  const reading = readTrackedPaths(root)
  if ('unreadable' in reading)
    return refused(ui, reading.unreadable)

  const classified = classifyRecordedFiles(root, record, reading.tracked)
  const changed = ofKind(classified, 'changed')
  if (changed.length > 0)
    return refused(ui, 'changed', changed)

  const { removed, leftBehind } = removeAttached(root, record, ofKind(classified, 'remove'), exclude)
  for (const target of removed)
    ui.line(`  ${ui.theme.dim('-')} ${target}`)
  for (const target of ofKind(classified, 'adopted'))
    ui.line(`  ${ui.lore.detachAdopted(target)}`)
  for (const target of ofKind(classified, 'absent'))
    ui.line(`  ${ui.lore.detachAlreadyAbsent(target)}`)
  for (const target of leftBehind)
    ui.line(`  ${ui.lore.detachLeftBehind(target)}`)
  ui.line(ui.theme.dim(`  ${ui.lore.detachBookkeeping}`))
  ui.ok(ui.lore.detached(removed.length))
  return { status: 'done', removed }
}
