import type { DiscoveryMarker, Manifest, MarkerProvenance } from '../../manifest.js'
import { DISCOVERY_MARKERS, sha256 } from '../../manifest.js'
import { markerBody, markerFileFor } from './discovery.js'

export type MarkerAuthorship = 'construct' | 'owner' | 'unknown'

export interface MarkerReading {
  marker: DiscoveryMarker
  file: string
  authorship: MarkerAuthorship
}

export function markerAuthorship(recorded: MarkerProvenance, body: string | null): MarkerAuthorship {
  if (recorded.authoredBy !== 'construct' || recorded.sha == null || body == null)
    return 'unknown'
  return sha256(body) === recorded.sha ? 'construct' : 'owner'
}

export function discoveryProvenance(root: string, manifest: Manifest): MarkerReading[] {
  return DISCOVERY_MARKERS.map((marker) => {
    const recorded = manifest.discovery.markers[marker]
    return {
      marker,
      file: recorded.file,
      authorship: markerAuthorship(recorded, markerBody(root, marker, markerFileFor(root, manifest, marker))),
    }
  })
}

export function constructAuthored(readings: MarkerReading[]): MarkerReading[] {
  return readings.filter(reading => reading.authorship === 'construct')
}
