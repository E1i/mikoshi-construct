import type { DiscoveryMarker, Manifest } from '../../manifest.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DISCOVERY_MARKERS } from '../../manifest.js'

export const DISCOVERY_PLACEHOLDER = '_Not discovered yet — run `/construct-discover`._'

export function markerOpen(marker: string): string {
  return `<!-- construct:discover:${marker} -->`
}

export function markerClose(marker: string): string {
  return `<!-- /construct:discover:${marker} -->`
}

export function isMarkerFilled(document: string, marker: string): boolean {
  const start = document.indexOf(markerOpen(marker))
  const stop = document.indexOf(markerClose(marker))
  if (start === -1 || stop === -1 || stop < start)
    return false
  const body = document.slice(start + markerOpen(marker).length, stop).trim()
  return body !== '' && body !== DISCOVERY_PLACEHOLDER
}

export function missingDiscovery(root: string, manifest: Manifest): DiscoveryMarker[] {
  return DISCOVERY_MARKERS.filter((marker) => {
    const location = path.join(root, manifest.discovery[marker])
    if (marker === 'composition')
      return !existsSync(location) || !readdirSync(location).some(file => file.endsWith('.yaml'))
    return !existsSync(location) || !isMarkerFilled(readFileSync(location, 'utf8'), marker)
  })
}
