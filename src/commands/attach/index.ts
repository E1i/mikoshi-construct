import type { Ui } from '../../ui/console.js'
import type { Lore, Notice } from '../../ui/lore.js'
import type { Prompter } from '../../ui/prompts.js'
import type { AttachRefusal, AttachRefusalReason } from './refusals.js'
import type { Rollback } from './rollback.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { sha256 } from '../../manifest.js'
import { AI_TARGETS } from '../../presets/index.js'
import { VERSION } from '../../version.js'
import { directoriesToCreate, planCarriers } from './carriers.js'
import { writeExcludeBlock } from './exclude.js'
import { fileEditingMarks, throughPackageRunners } from './harness.js'
import { ATTACH_LEDGER_DIR, ATTACH_RECORD_VERSION, writeAttachRecord } from './record.js'
import { harnessRefusal, refusalFor } from './refusals.js'
import { rollbackAttach } from './rollback.js'
import { writeCarriersExclusively } from './write.js'

export { planCarriers } from './carriers.js'
export { applyExcludeRemoval, EXCLUDE_FILE, pathsInExcludeBlock, planExcludeRemoval, readExcludeBlockPaths } from './exclude.js'
export type { ExcludeRemoval } from './exclude.js'
export { ATTACH_RECORD_FILE, readAttachRecord } from './record.js'
export type { AttachRecord } from './record.js'
export type { AttachRefusalReason } from './refusals.js'
export { removeEmptyDirectories } from './rollback.js'

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
  'nothing-to-attach': lore => lore.attachRefusedNothingToAttach,
  'collision': (lore, refusal) => lore.attachRefusedCollision(refusal.paths),
  'no-harness': lore => lore.attachRefusedNoHarness,
  'cursor': lore => lore.attachRefusedCursor,
  'not-a-command': (lore, { harness = { command: '', word: '' } }) => lore.attachRefusedNotACommand(harness.word, throughPackageRunners(harness.command, harness.word)),
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
  for (const target of refusal.paths)
    ui.line(`    ${ui.theme.dim(target)}`)
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

  const command = options.harness ?? await interactive?.harnessCommand() ?? null
  if (command == null)
    return aborted()
  const unresolved = harnessRefusal(command, (options.env ?? process.env).PATH ?? '')
  if (unresolved != null)
    return refused(ui, unresolved)
  const marks = fileEditingMarks(command)
  if (marks.length > 0) {
    const notice = ui.lore.attachHarnessEditsFiles(marks)
    ui.glitch(notice.what)
    explained(ui, notice)
  }

  const ops = planCarriers(root, command)
  const targets = ops.map(op => op.target)
  for (const target of targets)
    ui.line(`  ${ui.theme.ok('+')} ${target}`)
  ui.line()

  if (interactive != null && (await interactive.confirm(ui.lore.attachConfirm)) !== true)
    return aborted()

  const ledgerCreated = !existsSync(path.join(root, ATTACH_LEDGER_DIR))
  const exclude = writeExcludeBlock(root, targets)
  const directories = directoriesToCreate(root, targets)
  const write = writeCarriersExclusively(root, ops)
  if (write.collided != null) {
    const rollback = rollbackAttach(root, { written: write.written, directories, separator: exclude.separator })
    return refused(ui, { reason: 'collision', paths: [write.collided], rolledBack: true }, rollback)
  }
  const written = write.written
  writeAttachRecord(root, {
    recordVersion: ATTACH_RECORD_VERSION,
    construct: VERSION,
    attachedAt: new Date().toISOString(),
    harness: { command },
    files: Object.fromEntries(written.map(op => [op.target, sha256(op.content)])),
    directories,
    excludeCreated: exclude.created,
    excludeSeparator: exclude.separator,
    ledgerCreated,
  })

  ui.ok(ui.lore.attached)
  ui.tree([
    ['Trailer', ui.lore.attachTrailer(VERSION)],
    ['Pull request', ui.lore.attachPullRequest(VERSION)],
    ['Then', ui.lore.attachThen],
    ['Detach', ui.lore.attachDetach],
  ])
  ui.line(ui.theme.dim(`  ${ui.lore.attachLedgerExcluded}`))
  return { status: 'done', created: written.map(op => op.target), rolledBack: [] }
}
