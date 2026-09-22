import { existsSync, readdirSync } from 'node:fs'

export const CHANGESET_DIR = '.changeset'

export type ReleaseRoute = 'versioning' | 'publishing' | 'unknown'

export interface ReleaseRouteReading {
  dir: string
  route: ReleaseRoute
  pending: string[]
}

export function pendingChangesets(entries: string[]): string[] {
  return entries.filter(entry => entry.endsWith('.md') && entry.toLowerCase() !== 'readme.md')
}

export function routeFrom(entries: string[]): ReleaseRoute {
  return pendingChangesets(entries).length > 0 ? 'versioning' : 'publishing'
}

export function readReleaseRoute(dir = CHANGESET_DIR): ReleaseRouteReading {
  if (!existsSync(dir))
    return { dir, route: 'unknown', pending: [] }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return { dir, route: 'unknown', pending: [] }
  }

  return { dir, route: routeFrom(entries), pending: pendingChangesets(entries) }
}
