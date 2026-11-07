import type { Ui } from '../../ui/console.js'
import type { Lore, Notice } from '../../ui/lore.js'
import type { Prompter } from '../../ui/prompts.js'
import type { HarnessCandidate } from './harness.js'
import type { AttachHarness } from './record.js'
import type { AttachRefusal, AttachRefusalReason } from './refusals.js'
import type { Rollback } from './rollback.js'
import type { SettingsHook } from './settings.js'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DECISIONS_FILE, repositoryRoot } from '../../../scripts/core/bus-path.js'
import { DEFAULT_LANES, sha256 } from '../../manifest.js'
import { AI_TARGETS } from '../../presets/index.js'
import { parseLaneCount } from '../../ui/prompts.js'
import { VERSION } from '../../version.js'
import { readTrackedPaths } from '../detach/index-reader.js'
import { deployFactoryBeside, factoryHomeFor } from './beside.js'
import { browserEntriesHeldAtAttach, directoriesToCreate, planCarriers, runtimeHeldAtAttach } from './carriers.js'
import { carriersItsConstructTracks } from './constructed.js'
import { LEDGER_DIR, readExcludeBlockPaths, writeExcludeBlock } from './exclude.js'
import { hostWithoutFactory } from './forge.js'
import { fileEditingMarks, harnessCandidates, jobRunning, throughPackageRunners } from './harness.js'
import { dropOriginal, keepOriginal } from './original.js'
import { ATTACH_LEDGER_DIR, ATTACH_RECORD_FILE, ATTACH_RECORD_VERSION, attachedVersionOf, carriersReading, DEFAULT_PUSH_POLICY, NO_HARNESS, readAttachRecord, serveFromFlags, writeAttachRecord } from './record.js'
import { harnessRefusal, refusalFor, unresolvableCheckRefusal } from './refusals.js'
import { rollbackAttach } from './rollback.js'
import { browserLabExcludedCommand, excludedBrowserLabLocally, installHookEntries, isSettingsHook, readSettings, SETTINGS_FILE, withExclusionRecorded } from './settings.js'
import { shellWord } from './shell-word.js'
import { planCarrierUpgrade, planWindowHooks, rewriteCarrier, writeCarriersExclusively } from './write.js'

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
  requiredCheck?: string
  ai?: string
  lanes?: string
  serve?: string
  serveUrl?: string
  yes: boolean
  env?: NodeJS.ProcessEnv
}

export type AttachUpgradeRefusalReason = 'upgrade-flags' | 'not-attached' | 'record-version' | 'record-ahead' | 'carriers-ahead' | 'index-unreadable' | 'carrier-changed' | 'carrier-collision'

export interface AttachResult {
  status: 'done' | 'refused' | 'aborted'
  refusal?: AttachRefusalReason | AttachUpgradeRefusalReason
  created: string[]
  rewritten?: string[]
  rolledBack: string[]
}

export const ATTACH_EXIT: Record<AttachResult['status'] | 'required-check-unresolvable', number> = {
  'done': 0,
  'refused': 1,
  'aborted': 1,
  'required-check-unresolvable': 2,
}

export function attachExitOf(result: AttachResult): number {
  return result.refusal === 'required-check-unresolvable' ? ATTACH_EXIT[result.refusal] : ATTACH_EXIT[result.status]
}

const REFUSAL_LINE: Record<AttachRefusalReason, (lore: Lore, refusal: AttachRefusal) => string | Notice> = {
  'no-git': lore => lore.attachRefusedNoGit,
  'linked-git': lore => lore.attachRefusedLinkedGit,
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
  'required-check-unresolvable': lore => lore.attachRefusedRequiredCheck,
  'not-a-command': (lore, { harness = { command: '', word: '' } }) => lore.attachRefusedNotACommand(harness.word, throughPackageRunners(harness.command, harness.word).map(shellWord)),
}

export const OWNER_DECISIONS_HEADER = '# Owner decisions\n\nAppend-only. One dated line per decision; a later line may supersede an earlier one by naming it, never by editing it.\n'

export function writeOwnerDecisionsBeside(root: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  if (repositoryRoot(root) == null)
    return undefined
  const factoryHome = factoryHomeFor(root, env, home)
  if (factoryHome == null)
    return undefined
  const file = path.join(factoryHome, DECISIONS_FILE)
  if (existsSync(file))
    return undefined
  mkdirSync(factoryHome, { recursive: true })
  writeFileSync(file, OWNER_DECISIONS_HEADER, { flag: 'wx' })
  return file
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

function isRefusal(harness: AttachHarness | AttachRefusal): harness is AttachRefusal {
  return typeof harness === 'object' && 'reason' in harness
}

async function askHarness(ui: Ui, root: string, interactive: Prompter, requiredCheck: string | undefined): Promise<AttachHarness | AttachRefusal | undefined> {
  const candidates = harnessCandidates(root)
  printCandidates(ui, candidates)
  if (candidates.length === 0)
    return NO_HARNESS
  const command = await interactive.harnessCommand(candidates.map(candidate => candidate.command))
  if (command === undefined)
    return undefined
  if (command == null)
    return NO_HARNESS
  const chosen = candidates.find(candidate => candidate.command === command)
  if (chosen?.jobUnresolved === true && requiredCheck == null)
    return unresolvableCheckRefusal()
  return withJob(command, requiredCheck ?? chosen?.job)
}

function withJob(command: string, job: string | undefined): AttachHarness {
  return job == null ? { command } : { command, job }
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
  const lanesGiven = options.lanes == null ? undefined : parseLaneCount(options.lanes)
  const serve = serveFromFlags(options.serve, options.serveUrl)

  const carriedByItsConstruct = carriersItsConstructTracks(root)
  const refusal = refusalFor(root, options, carriedByItsConstruct)
  if (refusal != null)
    return refused(ui, refusal)

  if (!options.yes && prompter == null) {
    ui.glitch(ui.lore.attachNeedsTerminal)
    return aborted()
  }
  const interactive = options.yes ? undefined : prompter

  const forgeHost = hostWithoutFactory(root)
  if (forgeHost != null)
    ui.glitch(ui.lore.attachFactoryUnavailable(forgeHost))
  const asked = forgeHost != null || options.harness === NO_HARNESS ? NO_HARNESS : options.harness != null ? withJob(options.harness, options.requiredCheck) : interactive == null ? NO_HARNESS : await askHarness(ui, root, interactive, options.requiredCheck)
  if (asked == null)
    return aborted()
  if (isRefusal(asked))
    return refused(ui, asked)
  if (asked === NO_HARNESS)
    ui.line(`  ${ui.lore.attachHarnessNone}`)
  const unchecked = asked === NO_HARNESS ? null : checkedHarness(ui, asked.command, (options.env ?? process.env).PATH ?? '')
  if (unchecked != null)
    return refused(ui, unchecked)
  const derivedJob = asked !== NO_HARNESS && options.harness != null && options.requiredCheck == null ? jobRunning(root, options.harness) : undefined
  if (derivedJob === null)
    return refused(ui, unresolvableCheckRefusal())
  const harness = asked !== NO_HARNESS && derivedJob != null ? withJob(asked.command, derivedJob) : asked

  const lanes = lanesGiven ?? (interactive == null ? DEFAULT_LANES : await interactive.lanes(DEFAULT_LANES))
  if (lanes == null)
    return aborted()

  const ops = [...planCarriers(root, harness, carriedByItsConstruct), ...planWindowHooks()]
  const targets = ops.map(op => op.target)
  for (const target of targets)
    ui.line(`  ${ui.theme.ok('+')} ${target}`)
  ui.line(`  ${ui.lore.attachSettingsPlan(readSettings(root).kind === 'absent')}`)
  if (carriedByItsConstruct.length > 0)
    ui.line(`  ${ui.lore.attachItsConstructCarries(carriedByItsConstruct.length)}`)
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
  const installed = installHookEntries(root, reading)
  if (installed.kind !== 'installed') {
    const rollback = rollbackAttach(root, { written, directories: rollbackDirectories, separator: exclude.separator })
    if (kept != null)
      dropOriginal(kept.copy)
    const reason = installed.kind === 'guarded' ? 'collision' : 'settings-unreadable'
    return refused(ui, { reason, paths: [SETTINGS_FILE], rolledBack: true }, rollback)
  }
  const factoryBeside = forgeHost == null ? deployFactoryBeside(root) : undefined
  if (forgeHost == null)
    writeOwnerDecisionsBeside(root)
  writeAttachRecord(root, {
    recordVersion: ATTACH_RECORD_VERSION,
    construct: VERSION,
    attachedVersion: VERSION,
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
    lanes,
    factoryBeside,
    push: DEFAULT_PUSH_POLICY,
    serve,
  })

  ui.ok(ui.lore.attached)
  ui.tree([
    ['Trailer', ui.lore.attachTrailer(VERSION)],
    ['Pull request', ui.lore.attachPullRequest(VERSION)],
    ...(factoryBeside == null ? [] : [['Factory', ui.lore.attachFactoryBeside(factoryBeside.home)] as [string, string]]),
    ['Then', ui.lore.attachThen],
    ['Guard', ui.lore.attachGuard],
    ['Detach', ui.lore.attachDetach],
  ])
  ui.line(ui.theme.dim(`  ${ui.lore.attachLedgerExcluded}`))
  return { status: 'done', created: written.map(op => op.target), rolledBack: [] }
}

function refusedUpgrade(ui: Ui, reason: AttachUpgradeRefusalReason, line: string, paths: string[] = []): AttachResult {
  ui.flatline(line)
  for (const target of paths)
    ui.line(`    ${ui.theme.dim(target)}`)
  return { status: 'refused', refusal: reason, created: [], rolledBack: [] }
}

function flagsTheRecordHolds(options: AttachOptions): string[] {
  const given: Array<[string, string | undefined]> = [['--harness', options.harness], ['--required-check', options.requiredCheck], ['--ai', options.ai], ['--lanes', options.lanes], ['--serve', options.serve], ['--serve-url', options.serveUrl]]
  return given.filter(([, value]) => value != null).map(([flag]) => flag)
}

function upgradedSettingsHook(ui: Ui, root: string, hook: SettingsHook | undefined): SettingsHook | undefined {
  const recordable = isSettingsHook(hook) ? hook : null
  const exclusion = recordable == null ? null : excludedBrowserLabLocally(root)
  if (recordable == null || exclusion == null) {
    ui.glitch(ui.lore.initSettingsSkippedNoExclusion(browserLabExcludedCommand()))
    return hook
  }
  if (exclusion.added.length === 0)
    return hook
  ui.line(ui.theme.dim(`  ${ui.lore.initBrowserLabExcluded(browserLabExcludedCommand())}`))
  return withExclusionRecorded(recordable, exclusion)
}

export async function runAttachUpgrade(ui: Ui, options: AttachOptions, prompter?: Prompter): Promise<AttachResult> {
  const root = path.resolve(options.dir)
  const held = flagsTheRecordHolds(options)
  if (held.length > 0)
    return refusedUpgrade(ui, 'upgrade-flags', ui.lore.attachUpgradeRefusedFlags(held))
  const record = readAttachRecord(root)
  if (record == null)
    return refusedUpgrade(ui, 'not-attached', ui.lore.attachUpgradeRefusedNotAttached)
  const recordVersion: unknown = record.recordVersion
  if (typeof recordVersion !== 'number' || !Number.isInteger(recordVersion) || recordVersion < 1)
    return refusedUpgrade(ui, 'record-version', ui.lore.detachRefusedRecordVersion, [String(recordVersion)])
  if (recordVersion > ATTACH_RECORD_VERSION)
    return refusedUpgrade(ui, 'record-ahead', ui.lore.recordAhead(ATTACH_RECORD_FILE, 'recordVersion', recordVersion, ATTACH_RECORD_VERSION))
  const attachedVersion = attachedVersionOf(record)
  if (attachedVersion != null && carriersReading(attachedVersion, VERSION) === 'ahead')
    return refusedUpgrade(ui, 'carriers-ahead', ui.lore.attachUpgradeRefusedAhead(attachedVersion, VERSION))
  const index = readTrackedPaths(root)
  if ('unreadable' in index)
    return refusedUpgrade(ui, 'index-unreadable', ui.lore.attachUpgradeRefusedIndex)

  const ops = [...planCarriers(root, record.harness, carriersItsConstructTracks(root)), ...planWindowHooks()]
  const upgrade = planCarrierUpgrade(root, ops, record.files, index.tracked)
  if (upgrade.changed.length > 0)
    return refusedUpgrade(ui, 'carrier-changed', ui.lore.attachUpgradeRefusedChanged(upgrade.changed.length), upgrade.changed)
  if (upgrade.collided.length > 0)
    return refusedUpgrade(ui, 'carrier-collision', ui.lore.attachUpgradeRefusedCollision(upgrade.collided.length), upgrade.collided)

  const written = [...upgrade.rewrite, ...upgrade.create]
  if (written.length === 0 && attachedVersion === VERSION) {
    ui.ok(ui.lore.attachUpgradeCurrent(VERSION))
    const settingsHook = upgradedSettingsHook(ui, root, record.settingsHook)
    if (settingsHook !== record.settingsHook)
      writeAttachRecord(root, { ...record, settingsHook })
    return { status: 'done', created: [], rewritten: [], rolledBack: [] }
  }

  if (!options.yes && prompter == null) {
    ui.glitch(ui.lore.attachUpgradeNeedsTerminal)
    return aborted()
  }
  for (const { target } of upgrade.rewrite)
    ui.line(`  ${ui.theme.ok('~')} ${target}`)
  for (const { target } of upgrade.create)
    ui.line(`  ${ui.theme.ok('+')} ${target}`)
  ui.line()
  if (!options.yes && (await prompter?.confirm(ui.lore.attachUpgradeConfirm(VERSION))) !== true)
    return aborted()

  const created = upgrade.create.map(op => op.target)
  const directories = directoriesToCreate(root, written.map(op => op.target)).filter(directory => !record.directories.includes(directory))
  const blockHeld = readExcludeBlockPaths(root).filter(target => target !== LEDGER_DIR)
  const exclude = created.length === 0 ? null : writeExcludeBlock(root, [...new Set([...blockHeld, ...created])])
  const creation = writeCarriersExclusively(root, upgrade.create)
  if (creation.collided != null) {
    for (const op of creation.written)
      rmSync(path.join(root, op.target))
    return refusedUpgrade(ui, 'carrier-collision', ui.lore.attachUpgradeRefusedCollision(1), [creation.collided])
  }
  for (const op of upgrade.rewrite)
    rewriteCarrier(root, op)
  writeAttachRecord(root, {
    ...record,
    settingsHook: upgradedSettingsHook(ui, root, record.settingsHook),
    attachedVersion: VERSION,
    files: { ...record.files, ...Object.fromEntries(written.map(op => [op.target, sha256(op.content)])) },
    directories: [...record.directories, ...directories],
    excludeCreated: record.excludeCreated || exclude?.created === true,
    excludeSeparator: exclude != null && blockHeld.length === 0 ? exclude.separator : record.excludeSeparator,
  })

  ui.ok(ui.lore.attachUpgraded(VERSION))
  ui.line(ui.theme.dim(`  ${ui.lore.attachUpgradeKept}`))
  if (upgrade.adopted.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.attachUpgradeAdopted(upgrade.adopted)}`))
  const current = new Set(ops.map(op => op.target))
  const retired = Object.keys(record.files).filter(target => !current.has(target) && !index.tracked.has(target))
  if (retired.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.attachUpgradeRetired(retired)}`))
  if (record.settingsHook?.window == null)
    ui.glitch(ui.lore.attachUpgradeHooksOlder)
  return { status: 'done', created, rewritten: upgrade.rewrite.map(op => op.target), rolledBack: [] }
}
