import type { Ui } from '../../ui/console.js'
import type { Lore, Notice } from '../../ui/lore.js'
import type { Prompter } from '../../ui/prompts.js'
import type { HarnessCandidate } from './harness.js'
import type { AttachHarness } from './record.js'
import type { AttachRefusal, AttachRefusalReason } from './refusals.js'
import type { Rollback } from './rollback.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { sha256 } from '../../manifest.js'
import { AI_TARGETS } from '../../presets/index.js'
import { VERSION } from '../../version.js'
import { browserEntriesHeldAtAttach, directoriesToCreate, planCarriers, runtimeHeldAtAttach } from './carriers.js'
import { writeExcludeBlock } from './exclude.js'
import { fileEditingMarks, harnessCandidates, throughPackageRunners } from './harness.js'
import { dropOriginal, keepOriginal } from './original.js'
import { ATTACH_LEDGER_DIR, ATTACH_RECORD_VERSION, NO_HARNESS, writeAttachRecord } from './record.js'
import { harnessRefusal, refusalFor } from './refusals.js'
import { rollbackAttach } from './rollback.js'
import { installGuardEntry, readSettings, SETTINGS_FILE } from './settings.js'
import { shellWord } from './shell-word.js'
import { writeCarriersExclusively } from './write.js'

export { planCarriers } from './carriers.js'
export { printEntryProtocol } from './earlier.js'
export { applyExcludeRemoval, EXCLUDE_FILE, pathsInExcludeBlock, planExcludeRemoval, readExcludeBlockPaths } from './exclude.js'
export type { ExcludeRemoval } from './exclude.js'
export { ATTACH_RECORD_FILE, readAttachRecord } from './record.js'
export type { AttachRecord } from './record.js'
export type { AttachRefusalReason } from './refusals.js'
export { removeEmptyDirectories } from './rollback.js'
export { SETTINGS_FILE } from './settings.js'
export type { SettingsHook } from './settings.js'

export interface AttachOptions {
  dir: string
  harness?: string
  ai?: string
  yes: boolean
  env?: NodeJS.ProcessEnv
}

export interface AttachResult {
  status: 'done' | 'refused' | 'aborted'
  refusal?: AttachRefusalReason
  created: string[]
  rolledBack: string[]
}

export const ATTACH_EXIT: Record<AttachResult['status'], number> = {
  done: 0,
  refused: 1,
  aborted: 1,
}

const REFUSAL_LINE: Record<AttachRefusalReason, (lore: Lore, refusal: AttachRefusal) => string | Notice> = {
  'no-git': lore => lore.attachRefusedNoGit,
  'linked-git': lore => lore.attachRefusedLinkedGit,
  'constructed': lore => lore.attachRefusedConstructed,
  'attached': lore => lore.attachRefusedAttached,
  'nothing-to-attach': lore => lore.attachRefusedNothingToAttach,
  'collision': (lore, { paths, collision }) => {
    if (collision == null)
      return lore.attachRefusedCollision(paths)
    const recognised = collision.labels.filter(label => label != null).length
    return { what: lore.attachRefusedCollision(paths), ...lore.attachCollisionExplained(recognised, paths.length, collision.remove, collision.rerun) }
  },
  'settings-index': lore => lore.attachRefusedSettingsIndex,
  'settings-tracked': lore => lore.attachRefusedSettingsTracked,
  'settings-unreadable': lore => lore.attachRefusedSettingsUnreadable,
  'settings-guarded': lore => lore.attachRefusedSettingsGuarded,
  'settings-original': lore => lore.attachRefusedSettingsOriginal,
  'original-pending': lore => lore.attachRefusedOriginalPending,
  'cursor': lore => lore.attachRefusedCursor,
  'not-a-command': (lore, { harness = { command: '', word: '' } }) => lore.attachRefusedNotACommand(harness.word, throughPackageRunners(harness.command, harness.word).map(shellWord)),
}

function explained(ui: Ui, notice: Notice): void {
  ui.tree([
    ['Why', notice.why],
    ['Next', notice.next],
  ])
}

function refused(ui: Ui, refusal: AttachRefusal, rollback: Rollback = { removed: [], excludeKept: false }): AttachResult {
  const reading = REFUSAL_LINE[refusal.reason](ui.lore, refusal)
  ui.flatline(typeof reading === 'string' ? reading : reading.what)
  if (typeof reading !== 'string')
    explained(ui, reading)
  refusal.paths.forEach((target, index) => {
    const label = refusal.collision?.labels[index]
    const reading = refusal.collision == null ? '' : `  ${label == null ? ui.lore.attachCollisionForeign : ui.lore.attachCollisionEarlier(label.date)}`
    ui.line(`    ${ui.theme.dim(target)}${reading}`)
  })
  if (refusal.rolledBack === true) {
    ui.line(ui.theme.dim(`  ${ui.lore.attachRolledBack(rollback.removed.length)}`))
    for (const target of rollback.removed)
      ui.line(`  ${ui.theme.dim('-')} ${ui.theme.dim(target)}`)
    if (rollback.excludeKept)
      ui.glitch(ui.lore.attachBlockKept)
  }
  return { status: 'refused', refusal: refusal.reason, created: [], rolledBack: rollback.removed }
}

function aborted(): AttachResult {
  return { status: 'aborted', created: [], rolledBack: [] }
}

function printCandidates(ui: Ui, candidates: HarnessCandidate[]): void {
  if (candidates.length === 0) {
    ui.line(`  ${ui.lore.attachNoHarnessCandidates}`)
    return
  }
  ui.line(`  ${ui.lore.attachHarnessCandidates}`)
  candidates.forEach(({ command, source }, index) => ui.line(`    ${ui.lore.attachHarnessCandidate(index + 1, command, source)}`))
}

async function askHarness(ui: Ui, root: string, interactive: Prompter): Promise<AttachHarness | undefined> {
  const candidates = harnessCandidates(root)
  printCandidates(ui, candidates)
  if (candidates.length === 0)
    return NO_HARNESS
  const command = await interactive.harnessCommand(candidates.map(candidate => candidate.command))
  if (command === undefined)
    return undefined
  return command == null ? NO_HARNESS : { command }
}

function checkedHarness(ui: Ui, command: string, searchPath: string): AttachRefusal | null {
  const unresolved = harnessRefusal(command, searchPath)
  if (unresolved != null)
    return unresolved
  const marks = fileEditingMarks(command)
  if (marks.length > 0) {
    const notice = ui.lore.attachHarnessEditsFiles(marks)
    ui.glitch(notice.what)
    explained(ui, notice)
  }
  return null
}

export async function runAttach(ui: Ui, options: AttachOptions, prompter?: Prompter): Promise<AttachResult> {
  const root = path.resolve(options.dir)
  if (options.ai != null && !(AI_TARGETS as readonly string[]).includes(options.ai))
    throw new Error(`unknown AI target "${options.ai}" (claude | cursor | both)`)

  const refusal = refusalFor(root, options)
  if (refusal != null)
    return refused(ui, refusal)

  if (!options.yes && prompter == null) {
    ui.glitch(ui.lore.attachNeedsTerminal)
    return aborted()
  }
  const interactive = options.yes ? undefined : prompter

  const harness = options.harness != null ? { command: options.harness } : interactive == null ? NO_HARNESS : await askHarness(ui, root, interactive)
  if (harness == null)
    return aborted()
  if (harness === NO_HARNESS)
    ui.line(`  ${ui.lore.attachHarnessNone}`)
  const unchecked = harness === NO_HARNESS ? null : checkedHarness(ui, harness.command, (options.env ?? process.env).PATH ?? '')
  if (unchecked != null)
    return refused(ui, unchecked)

  const ops = planCarriers(root, harness)
  const targets = ops.map(op => op.target)
  for (const target of targets)
    ui.line(`  ${ui.theme.ok('+')} ${target}`)
  ui.line(`  ${ui.lore.attachSettingsPlan(readSettings(root).kind === 'absent')}`)
  ui.line()

  if (interactive != null && (await interactive.confirm(ui.lore.attachConfirm)) !== true)
    return aborted()

  const ledgerCreated = !existsSync(path.join(root, ATTACH_LEDGER_DIR))
  const ledgerHeld = runtimeHeldAtAttach(root)
  const browserHeld = browserEntriesHeldAtAttach(root)
  const exclude = writeExcludeBlock(root, [...targets, SETTINGS_FILE])
  const directories = directoriesToCreate(root, targets).filter(directory => directory !== ATTACH_LEDGER_DIR)
  const rollbackDirectories = ledgerCreated ? [ATTACH_LEDGER_DIR, ...directories] : directories
  const write = writeCarriersExclusively(root, ops)
  if (write.collided != null) {
    const rollback = rollbackAttach(root, { written: write.written, directories: rollbackDirectories, separator: exclude.separator })
    return refused(ui, { reason: 'collision', paths: [write.collided], rolledBack: true }, rollback)
  }
  const written = write.written
  const reading = readSettings(root)
  const kept = reading.kind === 'read' ? keepOriginal(root, reading.bytes) : null
  if (kept?.kind === 'failed') {
    const rollback = rollbackAttach(root, { written, directories: rollbackDirectories, separator: exclude.separator })
    return refused(ui, { reason: 'settings-original', paths: [kept.copy], rolledBack: true }, rollback)
  }
  const installed = installGuardEntry(root, reading)
  if (installed.kind !== 'installed') {
    const rollback = rollbackAttach(root, { written, directories: rollbackDirectories, separator: exclude.separator })
    if (kept != null)
      dropOriginal(kept.copy)
    const reason = installed.kind === 'guarded' ? 'collision' : 'settings-unreadable'
    return refused(ui, { reason, paths: [SETTINGS_FILE], rolledBack: true }, rollback)
  }
  writeAttachRecord(root, {
    recordVersion: ATTACH_RECORD_VERSION,
    construct: VERSION,
    attachedAt: new Date().toISOString(),
    harness,
    files: Object.fromEntries(written.map(op => [op.target, sha256(op.content)])),
    directories,
    excludeCreated: exclude.created,
    excludeSeparator: exclude.separator,
    ledgerCreated,
    ledgerHeld,
    browserHeld,
    settingsHook: kept == null ? installed.hook : { ...installed.hook, original: { copy: kept.copy, sha256: kept.sha256, afterSha256: installed.afterSha256 } },
  })

  ui.ok(ui.lore.attached)
  ui.tree([
    ['Trailer', ui.lore.attachTrailer(VERSION)],
    ['Pull request', ui.lore.attachPullRequest(VERSION)],
    ['Then', ui.lore.attachThen],
    ['Guard', ui.lore.attachGuard],
    ['Detach', ui.lore.attachDetach],
  ])
  ui.line(ui.theme.dim(`  ${ui.lore.attachLedgerExcluded}`))
  return { status: 'done', created: written.map(op => op.target), rolledBack: [] }
}
