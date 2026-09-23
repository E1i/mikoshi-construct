import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { Prompter } from '../../ui/prompts.js'
import type { AttachRefusal, AttachRefusalReason } from './refusals.js'
import path from 'node:path'
import { sha256 } from '../../manifest.js'
import { VERSION } from '../../version.js'
import { directoriesToCreate, planCarriers } from './carriers.js'
import { writeExcludeBlock } from './exclude.js'
import { ATTACH_RECORD_VERSION, writeAttachRecord } from './record.js'
import { refusalFor } from './refusals.js'
import { rollbackAttach } from './rollback.js'
import { writeCarriersExclusively } from './write.js'

export { planCarriers } from './carriers.js'
export { EXCLUDE_FILE, pathsInExcludeBlock, readExcludeBlockPaths, removeExcludeBlock } from './exclude.js'
export { ATTACH_RECORD_FILE, readAttachRecord } from './record.js'
export type { AttachRecord } from './record.js'
export type { AttachRefusalReason } from './refusals.js'
export { removeEmptyDirectories } from './rollback.js'

export interface AttachOptions {
  dir: string
  harness?: string
  ai?: string
  yes: boolean
}

export interface AttachResult {
  status: 'done' | 'refused' | 'aborted'
  refusal?: AttachRefusalReason
  created: string[]
  rolledBack: string[]
}

const AI_TARGETS = ['claude', 'cursor', 'both']

const REFUSAL_LINE: Record<AttachRefusalReason, (lore: Lore, paths: string[]) => string> = {
  'no-git': lore => lore.attachRefusedNoGit,
  'linked-git': lore => lore.attachRefusedLinkedGit,
  'constructed': lore => lore.attachRefusedConstructed,
  'unsupported-stack': lore => lore.attachRefusedUnsupportedStack,
  'collision': (lore, paths) => lore.attachRefusedCollision(paths),
  'no-harness': lore => lore.attachRefusedNoHarness,
  'cursor': lore => lore.attachRefusedCursor,
}

function refused(ui: Ui, refusal: AttachRefusal, rolledBack: string[] = []): AttachResult {
  ui.flatline(REFUSAL_LINE[refusal.reason](ui.lore, refusal.paths))
  for (const target of refusal.paths)
    ui.line(`    ${ui.theme.dim(target)}`)
  if (rolledBack.length > 0 || refusal.rolledBack === true) {
    ui.line(ui.theme.dim(`  ${ui.lore.attachRolledBack(rolledBack.length)}`))
    for (const target of rolledBack)
      ui.line(`  ${ui.theme.dim('-')} ${ui.theme.dim(target)}`)
  }
  return { status: 'refused', refusal: refusal.reason, created: [], rolledBack }
}

function aborted(): AttachResult {
  return { status: 'aborted', created: [], rolledBack: [] }
}

export async function runAttach(ui: Ui, options: AttachOptions, prompter?: Prompter): Promise<AttachResult> {
  const root = path.resolve(options.dir)
  if (options.ai != null && !AI_TARGETS.includes(options.ai))
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

  const ops = planCarriers(root, command)
  const targets = ops.map(op => op.target)
  for (const target of targets)
    ui.line(`  ${ui.theme.ok('+')} ${target}`)
  ui.line()

  if (interactive != null && (await interactive.confirm(ui.lore.attachConfirm)) !== true)
    return aborted()

  const exclude = writeExcludeBlock(root, targets)
  const directories = directoriesToCreate(root, targets)
  const write = writeCarriersExclusively(root, ops)
  if (write.collided != null) {
    const rolledBack = rollbackAttach(root, { written: write.written, directories, separator: exclude.separator })
    return refused(ui, { reason: 'collision', paths: [write.collided], rolledBack: true }, rolledBack)
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
