import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { Prompter } from '../../ui/prompts.js'
import type { IndexUnreadable } from './index-reader.js'
import type { DetachPreview } from './preview.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isBlockSeparator } from '../../materialize/strategies.js'
import { planExcludeRemoval, readExcludeBlockPaths } from '../attach/exclude.js'
import { dropOriginal } from '../attach/original.js'
import { ATTACH_RECORD_FILE, ATTACH_RECORD_VERSION, readAttachRecord } from '../attach/record.js'
import { classifyEntry, isSettingsHook, SETTINGS_FILE } from '../attach/settings.js'
import { keepAlivesHolding, removeBeside } from './beside.js'
import { classifyRecordedFiles, ofKind } from './classify.js'
import { readTrackedPaths } from './index-reader.js'
import { previewDetach } from './preview.js'
import { closeRecord, removeAttached } from './remove.js'
import { checkOriginal, takeOutGuardEntry } from './restore.js'
import { classifyRuntime, readRuntimeListing } from './runtime.js'

export type { IndexReading, IndexUnreadable } from './index-reader.js'
export { readTrackedPaths } from './index-reader.js'

export interface DetachOptions {
  dir: string
}

export interface AskedDetachOptions extends DetachOptions {
  yes: boolean
}

export type DetachRefusalReason = 'orphan-block' | 'record-version' | 'record-ahead' | 'hook-record' | 'separator' | 'separator-mismatch' | 'changed' | 'settings-unreadable' | 'original-copy' | 'factory-kept-alive' | 'beside-unremovable' | IndexUnreadable

export interface DetachResult {
  status: 'done' | 'nothing-attached' | 'refused' | 'aborted'
  refusal?: DetachRefusalReason
  removed: string[]
}

export interface DetachPlan {
  preview: DetachPreview
  apply: () => DetachResult
}

export const DETACH_EXIT: Record<DetachResult['status'], number> = {
  'done': 0,
  'nothing-attached': 0,
  'refused': 1,
  'aborted': 1,
}

const REFUSAL_LINE: Record<DetachRefusalReason, (lore: Lore, paths: string[]) => string> = {
  'orphan-block': lore => lore.detachRefusedOrphanBlock,
  'record-version': lore => lore.detachRefusedRecordVersion,
  'record-ahead': (lore, found) => lore.recordAhead(ATTACH_RECORD_FILE, 'recordVersion', Number(found[0]), ATTACH_RECORD_VERSION),
  'hook-record': lore => lore.detachRefusedHookRecord,
  'settings-unreadable': lore => lore.detachRefusedSettingsUnreadable,
  'original-copy': lore => lore.detachRefusedOriginalCopy,
  'factory-kept-alive': lore => lore.detachRefusedFactoryKeptAlive,
  'beside-unremovable': lore => lore.detachRefusedBesideUnremovable,
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

function aborted(ui: Ui): DetachResult {
  ui.line(ui.lore.detachAborted)
  return { status: 'aborted', removed: [] }
}

function onDiskLabel(ui: Ui, root: string, target: string): string {
  return `${target}  ${existsSync(path.join(root, target)) ? ui.lore.detachPresentOnDisk : ui.lore.detachAbsentOnDisk}`
}

function isPlan(outcome: DetachResult | DetachPlan): outcome is DetachPlan {
  return 'apply' in outcome
}

export function printDetachPreview(ui: Ui, preview: DetachPreview): void {
  ui.line(ui.lore.detachGoes)
  for (const entry of preview.entries)
    ui.line(`  ${'  '.repeat(entry.depth)}${ui.theme.dim('-')} ${ui.lore.detachGoesEntry(entry.target, entry.paths)}`)
  ui.line(`  ${ui.theme.dim('-')} ${ui.lore.detachGoesFiles(preview.files)}`)
  ui.line(ui.lore.detachGoesTotal(preview.total))
  ui.line()
}

export function planDetach(ui: Ui, options: DetachOptions): DetachResult | DetachPlan {
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
  const hook: unknown = record.settingsHook
  if (version >= 2 && !isSettingsHook(hook))
    return refused(ui, 'hook-record')
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
  const entry = isSettingsHook(hook) && version >= 2 ? classifyEntry(root, hook, reading.tracked) : null
  if (entry === 'unreadable')
    return refused(ui, 'settings-unreadable')
  const changed = [...ofKind(classified, 'changed'), ...(entry === 'changed' ? [SETTINGS_FILE] : [])]
  if (changed.length > 0)
    return refused(ui, 'changed', changed)

  const original = isSettingsHook(hook) && version >= 2 ? hook.original : undefined
  const kept = original == null ? null : checkOriginal(original)
  if (original != null && kept?.kind !== 'matched')
    return refused(ui, 'original-copy', [original.copy])
  const keptAlive = keepAlivesHolding(record.factoryBeside)
  if (keptAlive.length > 0)
    return refused(ui, 'factory-kept-alive', keptAlive.map(({ plist, unreadable }) => unreadable ? ui.lore.detachFactoryKeepAliveUnreadable(plist) : ui.lore.detachFactoryKeepAlive(plist)))
  const runtime = classifyRuntime(record, reading.tracked, readRuntimeListing(root))
  const preview = previewDetach(root, ofKind(classified, 'remove').length, runtime, record.factoryBeside)

  const apply = (): DetachResult => {
    const beside = removeBeside(root, record.factoryBeside)
    if ('unremovable' in beside)
      return refused(ui, 'beside-unremovable', [beside.unremovable])

    const entryLabel = ui.lore.detachSettingsEntry
    const { settingsDeleted, entryCutOut, bytesRestored } = entry === 'remove' && isSettingsHook(hook)
      ? takeOutGuardEntry(root, hook, kept)
      : { settingsDeleted: false, entryCutOut: false, bytesRestored: false }
    const removal = removeAttached(root, record, ofKind(classified, 'remove'), runtime)
    if (original != null)
      dropOriginal(original.copy)
    closeRecord(root, record, exclude)
    const removed = [...(settingsDeleted ? [SETTINGS_FILE] : []), ...removal.removed, ...beside.removed]
    const leftBehind = [...removal.leftBehind, ...beside.leftBehind]
    for (const target of removed)
      ui.line(`  ${ui.theme.dim('-')} ${target}`)
    if (entryCutOut)
      ui.line(`  ${ui.lore.detachEntryRemoved(SETTINGS_FILE)}`)
    if (bytesRestored)
      ui.line(`  ${ui.lore.detachOriginalRestored(SETTINGS_FILE)}`)
    for (const target of ofKind(classified, 'adopted'))
      ui.line(`  ${ui.lore.detachAdopted(target)}`)
    if (entry === 'adopted')
      ui.line(`  ${ui.lore.detachAdopted(entryLabel)}`)
    for (const target of ofKind(classified, 'absent'))
      ui.line(`  ${ui.lore.detachAlreadyAbsent(target)}`)
    if (entry === 'absent')
      ui.line(`  ${ui.lore.detachAlreadyAbsent(entryLabel)}`)
    for (const target of leftBehind)
      ui.line(`  ${ui.lore.detachLeftBehind(target)}`)
    ui.line(ui.theme.dim(`  ${ui.lore.detachBookkeeping}`))
    ui.ok(ui.lore.detached(removed.length))
    return { status: 'done', removed }
  }
  return { preview, apply }
}

export async function askDetach(ui: Ui, options: AskedDetachOptions, prompter?: Pick<Prompter, 'confirm'>): Promise<DetachResult> {
  const plan = planDetach(ui, options)
  if (!isPlan(plan))
    return plan
  printDetachPreview(ui, plan.preview)
  if (!options.yes) {
    if (prompter == null) {
      ui.glitch(ui.lore.detachNeedsTerminal)
      return aborted(ui)
    }
    if ((await prompter.confirm(ui.lore.detachConfirm)) !== true)
      return aborted(ui)
  }
  return plan.apply()
}
