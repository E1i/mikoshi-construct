import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { FACTORY_FOLDERS, FACTORY_NAMED, FACTORY_ROOT, FACTORY_RUNTIME } from '../core/factory-paths.js'

export const SILENT_MS = 20 * 60_000

export function beatsLive(ts: string, nowMs: number): boolean {
  return nowMs - Date.parse(ts) <= SILENT_MS
}

export const KNOWN_LIVENESS_SITES = FACTORY_RUNTIME.knownLivenessSites
export const LIVENESS_JUDGE = FACTORY_RUNTIME.busSupervisor
export const LIVENESS_RULE = FACTORY_NAMED.livenessSites

const SCANNED_ROOTS = [FACTORY_ROOT, 'src']
const UNSCANNED = `${FACTORY_FOLDERS.tests[0]}/`
const SCANNED_EXTENSIONS = ['.ts', '.mjs']

export type LivenessKind = 'ps' | 'pid-file' | 'kill'

export interface LivenessSite {
  file: string
  kind: LivenessKind
}

const PATTERNS: Record<LivenessKind, RegExp> = {
  'ps': /['"`]ps['"`]|['"`]ps\s+-\w|\bpgrep\b/,
  'pid-file': /\.pid['"`]|\bpid[-_]?file\b/i,
  'kill': /(?<![\w.])kill\(|\bprocess\.kill\(|\bchild\w*\.kill\(|['"`]p?kill['"`\s]|\bkillall\b/,
}

function siteKey(site: LivenessSite): string {
  return `${site.file} ${site.kind}`
}

export function sortedLivenessSites(sites: LivenessSite[]): LivenessSite[] {
  return [...new Map(sites.map(site => [siteKey(site), site])).values()].sort((a, b) => siteKey(a).localeCompare(siteKey(b)))
}

export function livenessSites(sources: ReadonlyMap<string, string>): LivenessSite[] {
  return sortedLivenessSites([...sources].filter(([file]) => file !== LIVENESS_JUDGE && file !== LIVENESS_RULE).flatMap(([file, text]) =>
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
