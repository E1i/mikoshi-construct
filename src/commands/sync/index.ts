import type { PathClass, PathClassification } from '../../sync/classify.js'
import { readManifest } from '../../manifest.js'
import { PATH_CLASSES } from '../../sync/classify.js'
import { replay } from '../../sync/replay.js'

export interface SyncReport {
  fromVersion: string
  toVersion: string
  counts: Record<PathClass, number>
  classifications: PathClassification[]
}

function countByClass(classifications: PathClassification[]): Record<PathClass, number> {
  const counts = Object.fromEntries(PATH_CLASSES.map(value => [value, 0])) as Record<PathClass, number>
  for (const entry of classifications)
    counts[entry.class] += 1
  return counts
}

export function runSync(root: string, version: string): SyncReport | null {
  const manifest = readManifest(root)
  if (manifest == null)
    return null
  const { fromVersion, toVersion, classifications } = replay({ root, manifest, version })
  return { fromVersion, toVersion, counts: countByClass(classifications), classifications }
}

export { LISTED_CLASSES, PENDING_CLASSES, printSync, SYNC_EXIT, syncExit, syncJson } from './report.js'
