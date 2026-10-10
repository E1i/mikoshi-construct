import path from 'node:path'
import { ownerPathsOf } from '../../src/commands/intake/check.js'
import { matchGlob } from '../shredder/glob.js'

export type Widening
  = | { kind: 'module', paths: string[], reason: string }
    | { kind: 'owner', paths: string[], reason: string }

const MIRRORS: [string, string][] = [['scripts/tests/', 'scripts/'], ['tests/', 'src/'], ['scripts/', 'scripts/'], ['src/', 'src/']]

export function moduleOf(file: string): string | null {
  const mirror = MIRRORS.find(([prefix]) => file.startsWith(prefix))
  if (mirror === undefined)
    return null
  const [prefix, home] = mirror
  return path.posix.dirname(`${home}${file.slice(prefix.length)}`)
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
