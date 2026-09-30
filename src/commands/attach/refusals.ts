import type { CollisionReading } from './earlier.js'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isEmptyDir } from '../../detect/layout.js'
import { ATTACH_CARRIERS } from '../../presets/index.js'
import { collisionReading } from './earlier.js'
import { unresolvedCommandWord } from './harness.js'

export type AttachRefusalReason = 'no-git' | 'linked-git' | 'constructed' | 'nothing-to-attach' | 'collision' | 'no-harness' | 'cursor' | 'not-a-command'

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

export function refusalFor(root: string, flags: AttachFlags): AttachRefusal | null {
  const git = path.join(root, '.git')
  if (!existsSync(git))
    return refusal('no-git')
  if (!statSync(git).isDirectory())
    return refusal('linked-git')
  if (existsSync(path.join(root, 'construct.json')))
    return refusal('constructed')
  if (isEmptyDir(root))
    return refusal('nothing-to-attach')
  const colliding = ATTACH_CARRIERS.targets.filter(target => existsSync(path.join(root, target)))
  if (colliding.length > 0)
    return { ...refusal('collision', colliding), collision: collisionReading(root, colliding, flags) }
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
