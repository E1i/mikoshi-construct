import { existsSync } from 'node:fs'
import path from 'node:path'
import { readTrackedPaths } from '../detach/index-reader.js'
import { ATTACH_WRITES } from './carriers.js'

export const CONSTRUCT_MANIFEST = 'construct.json'

export function carriersItsConstructTracks(root: string): string[] {
  if (!existsSync(path.join(root, CONSTRUCT_MANIFEST)))
    return []
  const index = readTrackedPaths(root)
  if ('unreadable' in index)
    return []
  return ATTACH_WRITES.filter(target => index.tracked.has(target))
}
