import type { DiscoveryMarker, Manifest, MarkerProvenance } from '../../manifest.js'
import { DISCOVERY_MARKERS, sha256 } from '../../manifest.js'
import { markerBody, markerFileFor } from './discovery.js'
import { FileReadings } from './readings.js'

export const MARKER_AUTHORSHIP = ['construct', 'owner', 'unrecorded', 'unreadable'] as const

export type MarkerAuthorship = (typeof MARKER_AUTHORSHIP)[number]

export interface MarkerReading {
  marker: DiscoveryMarker
  file: string
  authorship: MarkerAuthorship
}

export function markerAuthorship(recorded: MarkerProvenance, body: string | null): MarkerAuthorship {
  if (recorded.authoredBy === 'unknown')
    return 'unrecorded'
  if (body == null)
    return 'unreadable'
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

export function readingsBy(markers: MarkerReading[]): Record<MarkerAuthorship, MarkerReading[]> {
  return Object.fromEntries(MARKER_AUTHORSHIP.map(authorship =>
    [authorship, markers.filter(reading => reading.authorship === authorship)],
  )) as Record<MarkerAuthorship, MarkerReading[]>
}
