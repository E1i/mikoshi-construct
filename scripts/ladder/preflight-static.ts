import type { Witness } from '../ports/witnesses.js'
import { FACTORY_FORMER_FOLDERS, inScopes, scopeOf } from '../core/factory-paths.js'
import { GHOSTS_FILES, readGhostsFiles } from '../policy/shredder/reader.js'

export { movingRefRefusal } from '../../src/commands/intake/check.js'

export type ShowAt = (file: string) => string | null

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ghostsFileForm(entry: string): string {
  const scope = scopeOf(entry)
  return scope.endsWith('/') ? `${escapeRegExp(scope)}[\\w.-]+\\.\\w+` : escapeRegExp(scope)
}

const INVARIANT_WITNESS = /^(.*?) — witness: `([^`]+)`$/
const FILE_EXTENSION = /\.\w+$/
const IMMUTABLE_PATH = /^[\w.@+-]+(?:\/[\w.@+-]+)*\/?$/
const GHOSTS_FILE_FORMS = FACTORY_FORMER_FOLDERS.ghosts.map(ghostsFileForm).join('|')
const GHOSTS_FILE_IN_TEXT = new RegExp(`(?:${GHOSTS_FILE_FORMS})`, 'g')
const GHOSTS_FILE_CREATED_IN_TEXT = new RegExp(`(${GHOSTS_FILE_FORMS})\`? \\(creates, (?:ghosts|plain)\\)`, 'g')
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
  const declaredCreated = new Set([...design.matchAll(GHOSTS_FILE_CREATED_IN_TEXT)].map(found => found[1]!))
  const files = [...new Set([...named, ...changed])]
  const ghostsFiles = files.filter(file => inScopes(file, FACTORY_FORMER_FOLDERS.ghosts) && FILE_EXTENSION.test(file) && (changed.includes(file) || (show(file) === null && !declaredCreated.has(file))))
  return classificationRefusals(ghostsFilesText, ghostsFiles)[0] ?? null
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
