import type { DiscoveryMarker, Manifest, MarkerProvenance } from '../../manifest.js'
import { DISCOVERY_MARKERS, sha256 } from '../../manifest.js'
import { markerBody, markerFileFor } from './discovery.js'
import { FileReadings } from './readings.js'

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

export function discoveryProvenance(root: string, manifest: Manifest, readings: FileReadings = new FileReadings(root)): MarkerReading[] {
  return DISCOVERY_MARKERS.map((marker) => {
    const recorded = manifest.discovery.markers[marker]
    return {
      marker,
      file: recorded.file,
      authorship: markerAuthorship(recorded, markerBody(root, marker, markerFileFor(root, manifest, marker), readings)),
    }
  })
}

export function constructAuthored(markers: MarkerReading[]): MarkerReading[] {
  return markers.filter(reading => reading.authorship === 'construct')
}
