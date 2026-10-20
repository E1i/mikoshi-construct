import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const SILENT_MS = 20 * 60_000

export function beatsLive(ts: string, nowMs: number): boolean {
  return nowMs - Date.parse(ts) <= SILENT_MS
}

export const KNOWN_LIVENESS_SITES = 'scripts/bus/liveness-sites.known.json'
export const LIVENESS_JUDGE = 'scripts/bus/supervisor.ts'

const SCANNED_ROOTS = ['scripts', 'src']
const UNSCANNED = 'scripts/tests/'
const SCANNED_EXTENSIONS = ['.ts', '.mjs']

export type LivenessKind = 'ps' | 'pid-file' | 'kill'

export interface LivenessSite {
  file: string
  kind: LivenessKind
}

const PATTERNS: Record<LivenessKind, RegExp> = {
  'ps': /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*'ps'/,
  'pid-file': /\.pid['"`]/,
  'kill': /\bprocess\.kill\(/,
}

function siteKey(site: LivenessSite): string {
  return `${site.file} ${site.kind}`
}

export function sortedLivenessSites(sites: LivenessSite[]): LivenessSite[] {
  return [...new Map(sites.map(site => [siteKey(site), site])).values()].sort((a, b) => siteKey(a).localeCompare(siteKey(b)))
}

export function livenessSites(sources: ReadonlyMap<string, string>): LivenessSite[] {
  return sortedLivenessSites([...sources].filter(([file]) => file !== LIVENESS_JUDGE).flatMap(([file, text]) =>
    (Object.keys(PATTERNS) as LivenessKind[]).filter(kind => PATTERNS[kind].test(text)).map(kind => ({ file, kind }))))
}

function sourcesUnder(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory())
      return `${relative}/` === UNSCANNED ? [] : sourcesUnder(root, relative)
    return SCANNED_EXTENSIONS.some(extension => entry.name.endsWith(extension)) && !entry.name.endsWith('.d.ts') ? [relative] : []
  })
}

export function livenessSources(root: string): Map<string, string> {
  return new Map(SCANNED_ROOTS.flatMap(dir => sourcesUnder(root, dir)).map(file => [file, readFileSync(path.join(root, file), 'utf8')]))
}

export function knownLivenessSites(root: string): LivenessSite[] {
  return JSON.parse(readFileSync(path.join(root, KNOWN_LIVENESS_SITES), 'utf8')) as LivenessSite[]
}

export function unrecordedLivenessSites(found: LivenessSite[], known: LivenessSite[]): LivenessSite[] {
  const recorded = new Set(known.map(siteKey))
  return found.filter(site => !recorded.has(siteKey(site)))
}

export function staleLivenessSites(found: LivenessSite[], known: LivenessSite[]): LivenessSite[] {
  return unrecordedLivenessSites(known, found)
}
