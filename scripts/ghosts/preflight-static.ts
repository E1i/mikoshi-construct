import { matchGlob } from '../shredder/glob.js'
import { readOwnerMergeKinds, readPlainPaths } from '../shredder/reader.js'

export interface Witness { criterion: string, command: string }
export type ShowAt = (file: string) => string | null

const MOVING_REF = /\borigin\/main\b/
const INVARIANT_WITNESS = /^(.*?) — witness: `([^`]+)`$/
const GHOSTS_FILE = /^scripts\/ghosts\/[\w./-]+\.\w+$/
const SHIFT_FILE = /scripts\/shift\/[\w.-]+\.\w+/g
const IMMUTABLE_PATH = /^[\w.@+-]+(?:\/[\w.@+-]+)*\/?$/
const GHOSTS_FILE_IN_TEXT = /scripts\/ghosts\/[\w.-]+\.\w+/g
export const OWNER_MERGES = 'architecture/owner-merges.md'
const GENERATORS = [
  { path: 'templates/attach/earlier-carriers.json', command: 'pnpm exec tsx scripts/attach/earlier-carriers.ts' },
  { path: 'contract/surface.json', command: 'pnpm contract:update' },
  { path: 'architecture/composition/', command: 'pnpm composition:render' },
  { path: 'architecture/model.md', command: 'pnpm model:render' },
]

export function invariantWitnesses(invariants: string[]): Witness[] {
  return invariants.flatMap((item) => {
    const found = INVARIANT_WITNESS.exec(item)
    return found === null ? [] : [{ criterion: found[1]!, command: found[2]! }]
  })
}

export function unreadInvariantRefusal(invariants: string[]): string | null {
  const unread = invariants.find(item => !INVARIANT_WITNESS.test(item))
  return unread === undefined ? null : `invariant "${unread}" carries no witness the preflight can read, so it cannot be run on the base: end it with — witness: and the command in backticks`
}

export function movingRefRefusal(witnesses: Witness[]): string | null {
  const named = witnesses.find(witness => MOVING_REF.test(witness.command))
  return named === undefined ? null : `witness "${named.criterion}" names origin/main, which moves while the run goes; compare with HEAD, which the launcher pins at the base`
}

export function generatorRefusal(design: string, changed: string[]): string | null {
  const missing = GENERATORS.find(generator => (design.includes(generator.path) || changed.some(file => file.startsWith(generator.path)))
    && !design.includes(`The implementer runs \`${generator.command}\` without asking.`))
  return missing === undefined ? null : `the brief names ${missing.path}, a generated path, and its Design lacks the sentence: The implementer runs \`${missing.command}\` without asking.`
}

function classificationRefusals(ownerMergesText: string, ghostsFiles: string[]): string[] {
  const kinds = readOwnerMergeKinds(ownerMergesText)
  const plain = readPlainPaths(ownerMergesText)
  const ownerGlobs = kinds.find(kind => kind.kind === 'ghosts')?.globs ?? []
  return ghostsFiles.flatMap((file) => {
    const owner = ownerGlobs.some(glob => matchGlob(glob, file))
    const inPlain = plain.includes(file)
    if (owner && inPlain)
      return [`${file} is both owner and plain in ${OWNER_MERGES}`]
    if (!owner && !inPlain)
      return [`${file} is in no list of ${OWNER_MERGES}: add it to the kind ghosts or to the plain list (only Eli edits that file) before the hash`]
    return []
  })
}

function shiftRefusals(ownerMergesText: string, shiftFiles: string[], show: ShowAt): string[] {
  const ownInstructions = readOwnerMergeKinds(ownerMergesText).find(kind => kind.kind === 'own-instructions')?.globs ?? []
  return shiftFiles
    .filter(file => /merge/i.test(show(file) ?? '') && !ownInstructions.some(glob => matchGlob(glob, file)))
    .map(file => `${file} names a merge and is not under own-instructions in ${OWNER_MERGES}: add it to the kind own-instructions (only Eli edits that file) before the hash`)
}

export function ownerMergesRefusal(show: ShowAt, design: string, changed: string[]): string | null {
  const ownerMergesText = show(OWNER_MERGES)
  if (ownerMergesText === null)
    return null
  const named = [...design.matchAll(GHOSTS_FILE_IN_TEXT), ...design.matchAll(SHIFT_FILE)].map(found => found[0])
  const files = [...new Set([...named, ...changed])]
  const ghostsFiles = files.filter(file => GHOSTS_FILE.test(file) && (changed.includes(file) || show(file) === null))
  const shiftFiles = files.filter(file => file.startsWith('scripts/shift/') && show(file) !== null)
  return [...classificationRefusals(ownerMergesText, ghostsFiles), ...shiftRefusals(ownerMergesText, shiftFiles, show)][0] ?? null
}

export function immutableRefusal(changed: string[], immutable: string[]): string | null {
  const unread = immutable.filter(item => !IMMUTABLE_PATH.test(item))
  if (unread.length > 0)
    return `the brief's Immutable line holds ${unread.map(item => `"${item}"`).join(', ')}, which the ladder does not understand and so guards nothing: name each exact file, or a directory ending in /`
  for (const file of changed) {
    const held = immutable.find(item => file === item || file.startsWith(item.endsWith('/') ? item : `${item}/`))
    if (held !== undefined)
      return `the sketch changes ${file}, which the brief holds Immutable (${held})`
  }
  return null
}
