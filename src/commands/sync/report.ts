import type { PathClass, PathClassification } from '../../sync/classify.js'
import type { Ui } from '../../ui/console.js'
import type { SyncApplyReport, SyncReport } from './index.js'
import { PATH_CLASSES } from '../../sync/classify.js'
import { PENDING_CLASSES } from '../../sync/write.js'

export const SYNC_EXIT = {
  upToDate: 0,
  noManifest: 1,
  pending: 2,
} as const

export const SYNC_APPLY_EXIT = {
  written: 0,
  noManifest: 1,
  refused: 2,
} as const

export const LISTED_CLASSES: PathClass[] = ['add', 'update', 'conflict', 'unknown', 'removed', 'orphaned']

const CLASS_COLUMN = Math.max(...PATH_CLASSES.map(value => value.length)) + 2

function pendingCount(report: SyncReport): number {
  return PENDING_CLASSES.reduce((total, value) => total + report.counts[value], 0)
}

export function syncExit(report: SyncReport | null): number {
  if (report == null)
    return SYNC_EXIT.noManifest
  return pendingCount(report) === 0 ? SYNC_EXIT.upToDate : SYNC_EXIT.pending
}

function actionableKeys(entry: PathClassification): string[] {
  return entry.keys.filter(key => key.class !== 'keep').map(key => `${key.key} (${key.class})`)
}

export function syncJson(report: SyncReport): Record<string, unknown> {
  return {
    fromVersion: report.fromVersion,
    toVersion: report.toVersion,
    counts: report.counts,
    paths: report.classifications.map(entry => ({
      target: entry.target,
      class: entry.class,
      strategy: entry.strategy,
      ...(entry.keys.length === 0 ? {} : { keys: entry.keys }),
      ...(entry.variant == null ? {} : { variant: entry.variant.variant, variantEvidence: entry.variant.evidence }),
      ...(entry.shape == null ? {} : { shape: entry.shape }),
      ...(entry.writeEffect == null ? {} : { writeEffect: entry.writeEffect }),
    })),
  }
}

function note(ui: Ui, entry: PathClassification): string {
  if (entry.strategy === 'merge-json') {
    const keys = actionableKeys(entry)
    return keys.length === 0 ? '' : ui.lore.syncMergedKeys(keys)
  }
  if (entry.class === 'unknown')
    return ui.lore.syncVariantUnknown(entry.shape ?? '')
  return entry.writeEffect == null ? '' : ui.lore.syncWriteEffect[entry.writeEffect] ?? ''
}

const COUNT_ORDER: PathClass[] = ['add', 'update', 'conflict', 'unknown', 'removed', 'orphaned', 'keep', 'foreign']

function printCounts(ui: Ui, report: SyncReport): void {
  ui.line(ui.theme.accent(ui.lore.syncClasses))
  for (const value of COUNT_ORDER) {
    if (report.counts[value] === 0)
      continue
    const meaning = ui.lore.syncClassMeaning[value] ?? ''
    ui.line(`  ${value.padEnd(CLASS_COLUMN)}${String(report.counts[value]).padStart(3)}  ${ui.theme.dim(meaning)}`)
  }
}

function printPaths(ui: Ui, report: SyncReport): void {
  for (const value of LISTED_CLASSES) {
    const entries = report.classifications.filter(entry => entry.class === value)
    if (entries.length === 0)
      continue
    ui.line()
    ui.line(`${ui.theme.accent(value)} ${ui.theme.dim(`\u2014 ${ui.lore.syncClassMeaning[value] ?? ''}`)}`)
    for (const entry of entries) {
      const detail = note(ui, entry)
      ui.line(`  ${entry.target}${detail === '' ? '' : ui.theme.dim(` — ${detail}`)}`)
    }
  }
}

function printMergedNote(ui: Ui, report: SyncReport): void {
  const listed = report.classifications.filter(entry => LISTED_CLASSES.includes(entry.class))
  if (!listed.some(entry => entry.strategy === 'merge-json'))
    return
  ui.line()
  ui.line(ui.theme.dim(ui.lore.syncMergedNotWritten))
}

export function printSync(ui: Ui, report: SyncReport | null): number {
  if (report == null) {
    ui.flatline(ui.lore.syncNoManifest)
    return SYNC_EXIT.noManifest
  }

  ui.line(ui.theme.accent(ui.theme.bold(ui.lore.syncTitle)))
  ui.line(ui.theme.bold(ui.lore.syncVersionGap(report.fromVersion, report.toVersion)))
  ui.line()
  printCounts(ui, report)
  printPaths(ui, report)
  printMergedNote(ui, report)

  const pending = pendingCount(report)
  ui.line()
  ui.line(pending === 0 ? ui.lore.syncNothingToWrite : ui.lore.syncPending(pending))
  return syncExit(report)
}

export function syncApplyExit(result: SyncApplyReport | null): number {
  if (result == null)
    return SYNC_APPLY_EXIT.noManifest
  return result.refused.length === 0 ? SYNC_APPLY_EXIT.written : SYNC_APPLY_EXIT.refused
}

export function syncApplyJson(result: SyncApplyReport): Record<string, unknown> {
  return {
    ...syncJson(result.report),
    written: result.written,
    pending: result.refused.map(entry => entry.target),
    ranAt: result.ranAt,
  }
}

function printWritten(ui: Ui, result: SyncApplyReport): void {
  if (result.written.length === 0)
    return
  const byTarget = new Map(result.report.classifications.map(entry => [entry.target, entry]))
  ui.line()
  ui.line(ui.theme.accent(ui.lore.syncApplyWritten))
  for (const target of result.written) {
    const entry = byTarget.get(target)
    const detail = entry == null ? '' : note(ui, entry)
    ui.line(`  ${target}${detail === '' ? '' : ui.theme.dim(` — ${detail}`)}`)
  }
}

function printUnknownVariants(ui: Ui, result: SyncApplyReport): void {
  const unknown = result.report.classifications.filter(entry => entry.class === 'unknown')
  if (unknown.length === 0)
    return
  ui.line()
  ui.line(ui.theme.accent(ui.lore.syncApplyUnknown))
  for (const entry of unknown)
    ui.line(`  ${entry.target}${ui.theme.dim(` — ${note(ui, entry)}`)}`)
}

function printRefused(ui: Ui, result: SyncApplyReport): void {
  if (result.refused.length === 0)
    return
  ui.line()
  ui.line(ui.theme.accent(ui.lore.syncApplyRefused))
  for (const entry of result.refused) {
    const detail = note(ui, entry)
    ui.line(`  ${entry.target}${detail === '' ? '' : ui.theme.dim(` — ${detail}`)}`)
  }
  ui.line(ui.theme.dim(ui.lore.syncMergedNotWritten))
}

export function printSyncApply(ui: Ui, result: SyncApplyReport | null): number {
  if (result == null) {
    ui.flatline(ui.lore.syncNoManifest)
    return SYNC_APPLY_EXIT.noManifest
  }

  ui.line(ui.theme.accent(ui.theme.bold(ui.lore.syncApplyTitle)))
  ui.line(ui.theme.bold(ui.lore.syncVersionGap(result.report.fromVersion, result.report.toVersion)))
  printWritten(ui, result)
  printUnknownVariants(ui, result)
  printRefused(ui, result)

  ui.line()
  ui.line(result.written.length === 0 ? ui.lore.syncApplyNothingWritten : ui.lore.syncApplyWrote(result.written.length))
  if (result.refused.length > 0)
    ui.line(ui.lore.syncApplyLeftToYou(result.refused.length))
  return syncApplyExit(result)
}
