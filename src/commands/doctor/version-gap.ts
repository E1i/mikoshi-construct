import type { Manifest } from '../../manifest.js'
import { factsTheRepositoryEstablishes } from '../../detect/facts.js'
import { replay } from '../../sync/replay.js'
import { isPending } from '../../sync/write.js'

export interface VersionGap {
  materializedBy: string
  readBy: string
  pending: number | null
}

export function versionGap(root: string, manifest: Manifest, version: string): VersionGap {
  try {
    const { fromVersion, toVersion, classifications } = replay({ root, manifest, version, facts: factsTheRepositoryEstablishes(root) })
    return { materializedBy: fromVersion, readBy: toVersion, pending: classifications.filter(isPending).length }
  }
  catch {
    return { materializedBy: manifest.construct, readBy: version, pending: null }
  }
}
