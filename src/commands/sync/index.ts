import type { PathClass, PathClassification } from '../../sync/classify.js'
import { factsTheRepositoryEstablishes } from '../../detect/facts.js'
import { readManifest, recordSync, writeManifest } from '../../manifest.js'
import { applyPlan } from '../../materialize/apply.js'
import { PATH_CLASSES } from '../../sync/classify.js'
import { replay } from '../../sync/replay.js'
import { planWrites } from '../../sync/write.js'

export interface SyncReport {
  fromVersion: string
  toVersion: string
  counts: Record<PathClass, number>
  classifications: PathClassification[]
}

export interface SyncApplyReport {
  report: SyncReport
  written: string[]
  refused: PathClassification[]
  ranAt: string
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
  const { fromVersion, toVersion, classifications } = replay({ root, manifest, version, facts: factsTheRepositoryEstablishes(root) })
  return { fromVersion, toVersion, counts: countByClass(classifications), classifications }
}

export function applySync(root: string, version: string): SyncApplyReport | null {
  const manifest = readManifest(root)
  if (manifest == null)
    return null
  const { fromVersion, toVersion, present, produced, classifications } = replay({ root, manifest, version, facts: factsTheRepositoryEstablishes(root) })
  const report = { fromVersion, toVersion, counts: countByClass(classifications), classifications }
  const { writes, refused } = planWrites({ classifications, present, produced })

  const written = applyPlan(root, writes.map(write => ({ target: write.target, strategy: write.strategy, action: 'create' as const, content: write.content })))
  const ranAt = new Date().toISOString()
  if (writes.length > 0) {
    writeManifest(root, recordSync(manifest, {
      ranAt,
      toVersion: version,
      files: Object.fromEntries(writes.map(write => [write.target, write.ownedSha])),
      variants: Object.fromEntries(writes.flatMap(write => (write.variant == null ? [] : [[write.target, write.variant] as const]))),
    }))
  }

  return { report, written: written.map(op => op.target), refused, ranAt }
}

export { PENDING_CLASSES } from '../../sync/write.js'
export { LISTED_CLASSES, printSync, printSyncApply, SYNC_APPLY_EXIT, SYNC_EXIT, SYNC_JSON_SCHEMA_VERSION, SYNC_NO_MANIFEST_JSON, syncApplyExit, syncApplyJson, syncExit, syncJson } from './report.js'
