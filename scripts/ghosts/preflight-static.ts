import { GHOSTS_FILES, readGhostsFiles } from '../shredder/reader.js'

export interface Witness { criterion: string, command: string }
export type ShowAt = (file: string) => string | null

const MOVING_REF = /\borigin\/main\b/
const INVARIANT_WITNESS = /^(.*?) — witness: `([^`]+)`$/
const GHOSTS_FILE = /^scripts\/ghosts\/[\w./-]+\.\w+$/
const GHOSTS_FILE_IN_TEXT = /scripts\/ghosts\/[\w.-]+\.\w+/g
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

function classificationRefusals(ghostsFilesText: string, ghostsFiles: string[]): string[] {
  const rows = readGhostsFiles(ghostsFilesText)
  return ghostsFiles.flatMap((file) => {
    const owner = rows.some(row => row.file === file && row.kind === 'ghosts')
    const inPlain = rows.some(row => row.file === file && row.kind === 'plain')
    if (owner && inPlain)
      return [`${file} is both ghosts and plain in ${GHOSTS_FILES}`]
    if (!owner && !inPlain)
      return [`${file} has no row in ${GHOSTS_FILES}: add its row with the kind ghosts or plain before the hash`]
    return []
  })
}

export function ghostsFilesRefusal(show: ShowAt, design: string, changed: string[]): string | null {
  const ghostsFilesText = show(GHOSTS_FILES)
  if (ghostsFilesText === null)
    return null
  const named = [...design.matchAll(GHOSTS_FILE_IN_TEXT)].map(found => found[0])
  const files = [...new Set([...named, ...changed])]
  const ghostsFiles = files.filter(file => GHOSTS_FILE.test(file) && (changed.includes(file) || show(file) === null))
  return classificationRefusals(ghostsFilesText, ghostsFiles)[0] ?? null
}

export function immutableRefusal(changed: string[], immutable: string[]): string | null {
  for (const file of changed) {
    const held = immutable.find(item => file === item || file.startsWith(item.endsWith('/') ? item : `${item}/`))
    if (held !== undefined)
      return `the sketch changes ${file}, which the brief holds Immutable (${held})`
  }
  return null
}
