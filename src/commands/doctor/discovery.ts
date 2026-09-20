import type { DiscoveryMarker, Manifest } from '../../manifest.js'
import path from 'node:path'
import { factsTheRepositoryEstablishes } from '../../detect/facts.js'
import { DISCOVERY_MARKERS } from '../../manifest.js'
import { FileReadings } from './readings.js'

export const DISCOVERY_PLACEHOLDER = '_Not discovered yet — run `/construct-discover`._'

export function markerOpen(marker: string): string {
  return `<!-- construct:discover:${marker} -->`
}

export function markerClose(marker: string): string {
  return `<!-- /construct:discover:${marker} -->`
}

export function blockBody(document: string, marker: string): string | null {
  const start = document.indexOf(markerOpen(marker))
  const stop = document.indexOf(markerClose(marker))
  if (start === -1 || stop === -1 || stop < start)
    return null
  const body = document.slice(start + markerOpen(marker).length, stop).trim()
  return body === '' || body === DISCOVERY_PLACEHOLDER ? null : body
}

export function isMarkerFilled(document: string, marker: string): boolean {
  return blockBody(document, marker) != null
}

function compositionBody(directory: string, readings: FileReadings): string | null {
  const models = (readings.entries(directory) ?? []).filter(file => file.endsWith('.yaml')).sort()
  const bodies = models.flatMap((model) => {
    const source = readings.read(path.posix.join(directory, model))
    return source == null ? [] : [`${model}\n${source}`]
  })
  return bodies.length === 0 ? null : bodies.join('\n')
}

export function markerBody(root: string, marker: DiscoveryMarker, file: string, readings: FileReadings = new FileReadings(root)): string | null {
  if (marker === 'composition')
    return compositionBody(file, readings)
  const source = readings.read(file)
  return source == null ? null : blockBody(source, marker)
}

export function markerFileFor(root: string, manifest: Manifest, marker: DiscoveryMarker): string {
  const recordedFile = manifest.discovery.markers[marker].file
  if (marker !== 'composition')
    return recordedFile
  const decided = manifest.vars?.compositionDir
  if (decided != null && decided !== '')
    return decided
  return factsTheRepositoryEstablishes(root).compositionDir ?? recordedFile
}

export function missingDiscovery(root: string, manifest: Manifest, readings: FileReadings = new FileReadings(root)): DiscoveryMarker[] {
  return DISCOVERY_MARKERS.filter(marker => markerBody(root, marker, markerFileFor(root, manifest, marker), readings) == null)
}
