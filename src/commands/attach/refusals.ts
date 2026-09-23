import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { detect } from '../../detect/index.js'
import { ATTACH_CARRIERS } from '../../presets/index.js'

export type AttachRefusalReason = 'no-git' | 'linked-git' | 'constructed' | 'unsupported-stack' | 'collision' | 'no-harness' | 'cursor'

export interface AttachRefusal {
  reason: AttachRefusalReason
  paths: string[]
  rolledBack?: boolean
}

export interface AttachFlags {
  harness?: string
  ai?: string
  yes: boolean
}

const UNSUPPORTED_LAYOUTS = ['empty', 'unknown']
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
  if (UNSUPPORTED_LAYOUTS.includes(detect(root).layout))
    return refusal('unsupported-stack')
  const colliding = ATTACH_CARRIERS.targets.filter(target => existsSync(path.join(root, target)))
  if (colliding.length > 0)
    return refusal('collision', colliding)
  if (flags.yes && flags.harness == null)
    return refusal('no-harness')
  if (flags.ai != null && AI_OUT_OF_SCOPE.includes(flags.ai))
    return refusal('cursor')
  return null
}
