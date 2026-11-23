import type { PathClass, PathClassification } from '../../sync/classify.js'
import type { PlannedWrite } from '../../sync/write.js'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { factsTheRepositoryEstablishes } from '../../detect/facts.js'
import { blocksWrittenWith, readManifest, recordSync, writeManifest } from '../../manifest.js'
import { applyPlan } from '../../materialize/apply.js'
import { PATH_CLASSES } from '../../sync/classify.js'
import { ownedSha } from '../../sync/ownership.js'
import { replay } from '../../sync/replay.js'
import { planWrites } from '../../sync/write.js'
import { excludedBrowserLabInTheConstruct, settledProjectSettings } from '../attach/index.js'
import { browserLabExcludedCommand, PROJECT_SETTINGS_FILE, wroteLocally } from '../attach/settings.js'

export interface SyncReport {
  fromVersion: string
  toVersion: string
  counts: Record<PathClass, number>
  classifications: PathClassification[]
}

export interface SyncApplyReport {
  report: SyncReport
  written: string[]
  retired: string[]
  refused: PathClassification[]
  ranAt: string
  browserLabExclusion: BrowserLabExclusion | null
}

export interface BrowserLabExclusion {
  command: string
  state: 'added' | 'held' | 'refused'
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

function excludeInstalledLab(root: string, home: string): BrowserLabExclusion {
  const exclusion = excludedBrowserLabInTheConstruct(root, home)
  const command = browserLabExcludedCommand(home)
  if (exclusion == null)
    return { command, state: 'refused' }
  return { command, state: wroteLocally(exclusion) ? 'added' : 'held' }
}

interface EnvironmentPlan {
  classifications: PathClassification[]
  writes: PlannedWrite[]
}

function settledWrite(root: string, write: PlannedWrite): PlannedWrite {
  const content = settledProjectSettings(root, write.content)
  return content === null || content === write.content ? write : { ...write, content, ownedSha: ownedSha(write.target, content) }
}

function environmentWriteOfKept(root: string, classification: PathClassification, present: string | undefined): PlannedWrite | null {
  if (classification.target !== PROJECT_SETTINGS_FILE || classification.class !== 'keep' || present === undefined)
    return null
  const content = settledProjectSettings(root, present)
  if (content === null || content === present)
    return null
  return { target: classification.target, strategy: classification.strategy, content, ownedSha: ownedSha(classification.target, content), variant: null, writeEffect: null }
}

function withTheRoleEnvironment(root: string, classifications: PathClassification[], present: Record<string, string>, writes: PlannedWrite[]): EnvironmentPlan {
  const settled = writes.map(write => write.target === PROJECT_SETTINGS_FILE ? settledWrite(root, write) : write)
  const kept = classifications.map(classification => ({ classification, write: environmentWriteOfKept(root, classification, present[classification.target]) }))
  return {
    classifications: kept.map(({ classification, write }) => write === null ? classification : { ...classification, class: 'update' as const }),
    writes: [...settled, ...kept.flatMap(({ write }) => write === null ? [] : [write])],
  }
}

export function applySync(root: string, version: string, home: string = homedir()): SyncApplyReport | null {
  const manifest = readManifest(root)
  if (manifest == null)
    return null
  const replayed = replay({ root, manifest, version, facts: factsTheRepositoryEstablishes(root) })
  const { fromVersion, toVersion, present, produced } = replayed
  const planned = planWrites({ classifications: replayed.classifications, present, produced })
  const { removals, refused } = planned
  const { classifications, writes } = withTheRoleEnvironment(root, replayed.classifications, present, planned.writes)
  const report = { fromVersion, toVersion, counts: countByClass(classifications), classifications }

  for (const target of removals)
    rmSync(path.join(root, target))

  const written = applyPlan(root, writes.map(write => ({ target: write.target, strategy: write.strategy, action: 'create' as const, content: write.content })))
  const ranAt = new Date().toISOString()
  if (writes.length > 0) {
    writeManifest(root, recordSync(manifest, {
      ranAt,
      toVersion: version,
      files: Object.fromEntries(writes.map(write => [write.target, write.ownedSha])),
      variants: Object.fromEntries(writes.flatMap(write => (write.variant == null ? [] : [[write.target, write.variant] as const]))),
      blocks: blocksWrittenWith(Object.fromEntries(writes.filter(write => write.strategy === 'append-block').map(write => [write.target, write.ownedSha])), manifest.vars),
    }))
  }

  return { report, written: written.map(op => op.target), retired: removals, refused, ranAt, browserLabExclusion: PROJECT_SETTINGS_FILE in produced ? excludeInstalledLab(root, home) : null }
}

export { PENDING_CLASSES } from '../../sync/write.js'
export { LISTED_CLASSES, printSync, printSyncApply, SYNC_APPLY_EXIT, SYNC_EXIT, SYNC_JSON_SCHEMA_VERSION, SYNC_NO_MANIFEST_JSON, syncApplyExit, syncApplyJson, syncExit, syncJson } from './report.js'
