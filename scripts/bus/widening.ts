import path from 'node:path'
import { ownerPathsOf } from '../../src/commands/intake/check.js'
import { matchGlob } from '../shredder/glob.js'

export type Widening
  = | { kind: 'module', paths: string[], reason: string }
    | { kind: 'owner', paths: string[], reason: string }

const MIRRORS: [string, string][] = [['scripts/tests/', 'scripts/'], ['tests/', 'src/'], ['scripts/', 'scripts/'], ['src/', 'src/']]
const GLOB_SEGMENT = /[*?[{]/

function directoryOf(entry: string): string {
  const segments = entry.split('/').filter(segment => segment !== '')
  const firstGlob = segments.findIndex(segment => GLOB_SEGMENT.test(segment))
  if (firstGlob !== -1)
    return segments.slice(0, firstGlob).join('/')
  const namesADirectory = entry.endsWith('/') || path.posix.extname(segments.at(-1) ?? '') === ''
  return namesADirectory ? segments.join('/') : segments.slice(0, -1).join('/')
}

export function moduleOf(file: string): string | null {
  const mirror = MIRRORS.find(([prefix]) => file.startsWith(prefix))
  if (mirror === undefined)
    return null
  const [prefix, home] = mirror
  return directoryOf(`${home}${file.slice(prefix.length)}`)
}

function ownerGlobs(ownerMergesText: string): string[] {
  const owner = ownerPathsOf(ownerMergesText)
  return [...owner.globs, ...owner.byRisk.flatMap(row => row.globs)]
}

export function wideningOf(paths: string[], touches: string[], ownerMergesText: string): Widening {
  const globs = ownerGlobs(ownerMergesText)
  const ownerPath = paths.find(file => globs.some(glob => matchGlob(glob, file)))
  if (ownerPath !== undefined)
    return { kind: 'owner', paths, reason: `${ownerPath} is an owner path` }
  const modules = new Set(touches.map(moduleOf).filter(module => module !== null))
  const outside = paths.find(file => !modules.has(moduleOf(file) ?? ''))
  if (outside !== undefined)
    return { kind: 'owner', paths, reason: `${outside} is outside the module of the card's touches (${[...modules].join(', ') || 'none under src/ or scripts/'})` }
  return { kind: 'module', paths, reason: `${paths.join(', ')} ${paths.length === 1 ? 'is' : 'are'} in ${[...new Set(paths.map(moduleOf))].join(', ')}, the module the card already touches` }
}
