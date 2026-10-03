import type { CollisionReading } from './earlier.js'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isEmptyDir } from '../../detect/layout.js'
import { readTrackedPaths } from '../detach/index-reader.js'
import { ATTACH_WRITES } from './carriers.js'
import { collisionReading } from './earlier.js'
import { unresolvedCommandWord } from './harness.js'
import { ATTACH_LEDGER_DIR } from './record.js'
import { carriesGuardEntry, readSettings, SETTINGS_FILE, settingsExist } from './settings.js'

export type AttachRefusalReason = 'no-git' | 'linked-git' | 'constructed' | 'nothing-to-attach' | 'collision' | 'settings-index' | 'settings-tracked' | 'settings-unreadable' | 'settings-guarded' | 'no-harness' | 'cursor' | 'not-a-command'

export interface AttachRefusal {
  reason: AttachRefusalReason
  paths: string[]
  rolledBack?: boolean
  collision?: CollisionReading
  harness?: { command: string, word: string }
}

export interface AttachFlags {
  harness?: string
  ai?: string
  yes: boolean
}

const AI_OUT_OF_SCOPE = ['cursor', 'both']

function refusal(reason: AttachRefusalReason, paths: string[] = []): AttachRefusal {
  return { reason, paths }
}

function settingsRefusal(root: string): AttachRefusal | null {
  if (!settingsExist(root))
    return null
  const paths = [SETTINGS_FILE]
  const index = readTrackedPaths(root)
  if ('unreadable' in index)
    return refusal('settings-index', paths)
  if (index.tracked.has(SETTINGS_FILE))
    return refusal('settings-tracked', paths)
  const reading = readSettings(root)
  if (reading.kind === 'unreadable')
    return refusal('settings-unreadable', paths)
  if (reading.kind === 'read' && carriesGuardEntry(reading.settings))
    return refusal('settings-guarded', paths)
  return null
}

export function refusalFor(root: string, flags: AttachFlags): AttachRefusal | null {
  const git = path.join(root, '.git')
  if (!existsSync(git))
    return refusal('no-git')
  if (!statSync(git).isDirectory())
    return refusal('linked-git')
  if (existsSync(path.join(root, 'construct.json')))
    return refusal('constructed')
  if (isEmptyDir(root, [ATTACH_LEDGER_DIR]))
    return refusal('nothing-to-attach')
  const colliding = ATTACH_WRITES.filter(target => existsSync(path.join(root, target)))
  if (colliding.length > 0)
    return { ...refusal('collision', colliding), collision: collisionReading(root, colliding, flags) }
  const settings = settingsRefusal(root)
  if (settings != null)
    return settings
  if (flags.yes && flags.harness == null)
    return refusal('no-harness')
  if (flags.ai != null && AI_OUT_OF_SCOPE.includes(flags.ai))
    return refusal('cursor')
  return null
}

export function harnessRefusal(command: string, searchPath: string): AttachRefusal | null {
  const word = unresolvedCommandWord(command, searchPath)
  return word == null ? null : { reason: 'not-a-command', paths: [], harness: { command, word } }
}
