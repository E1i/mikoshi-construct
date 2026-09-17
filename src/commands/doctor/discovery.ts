import type { DiscoveryMarker, Manifest } from '../../manifest.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { factsTheRepositoryEstablishes } from '../../detect/facts.js'
import { DISCOVERY_MARKERS } from '../../manifest.js'

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

function compositionBody(directory: string): string | null {
  if (!existsSync(directory))
    return null
  const models = readdirSync(directory).filter(file => file.endsWith('.yaml')).sort()
  if (models.length === 0)
    return null
  return models.map(model => `${model}\n${readFileSync(path.join(directory, model), 'utf8')}`).join('\n')
}

export function markerBody(root: string, marker: DiscoveryMarker, file: string): string | null {
  const location = path.join(root, file)
  if (marker === 'composition')
    return compositionBody(location)
  if (!existsSync(location))
    return null
  return blockBody(readFileSync(location, 'utf8'), marker)
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

export function missingDiscovery(root: string, manifest: Manifest): DiscoveryMarker[] {
  return DISCOVERY_MARKERS.filter(marker => markerBody(root, marker, markerFileFor(root, manifest, marker)) == null)
}
