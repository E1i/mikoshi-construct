import { expandGlob } from './glob.js'

const LABEL_LINE = /^(Design|Effort|Acceptance|Invariants|Immutable|Mutations)(?:\s*\([^)]*\))?:/gm
const PATHS_LINE = /^Paths:(.*)$/m
const TOKEN = /[\w./-]+/g

function splitOutsideBackticks(body: string): string[] {
  const items = ['']
  let quoted = false
  for (const character of body) {
    if (character === '`')
      quoted = !quoted
    if (character === ';' && !quoted)
      items.push('')
    else
      items[items.length - 1] += character
  }
  return items
}

function stripQuotes(item: string): string {
  const trimmed = item.trim()
  const quoted = /^`([^`]+)`$/.exec(trimmed)
  return quoted ? quoted[1]! : trimmed
}

export function issuePaths(text: string, files: string[]): string[] {
  const line = PATHS_LINE.exec(text)?.[1]?.trim()
  if (line == null)
    return []
  const items = splitOutsideBackticks(line).map(stripQuotes).filter(item => item !== '')
  const matches = new Set<string>()
  for (const item of items) {
    for (const file of expandGlob(item, files))
      matches.add(file)
  }
  return [...matches]
}

function designSectionBody(text: string): string | null {
  const designStart = /^Design:/m.exec(text)
  if (designStart == null)
    return null
  const bodyStart = designStart.index + designStart[0].length
  const labels = [...text.matchAll(LABEL_LINE)].filter(match => match.index > designStart.index)
  const bodyEnd = labels[0]?.index ?? text.length
  return text.slice(bodyStart, bodyEnd)
}

export function briefPaths(text: string, files: string[]): string[] {
  const body = designSectionBody(text)
  if (body == null)
    return []
  const matches = new Set<string>()
  for (const rawToken of body.matchAll(TOKEN)) {
    const token = rawToken[0].replace(/\.+$/, '')
    if (token === '')
      continue
    if (files.includes(token)) {
      matches.add(token)
      continue
    }
    const suffixMatches = files.filter(file => file.endsWith(`/${token}`))
    if (suffixMatches.length === 1)
      matches.add(suffixMatches[0]!)
  }
  return [...matches]
}

export const HOT_FILES = ['src/program.ts', 'src/ui/lore.ts', 'contract/surface.json']

const PROGRAM_TS = 'src/program.ts'
const CONTRACT_SURFACE = 'contract/surface.json'
const CLI_HELP_GLOB = 'tests/fixtures/cli-help/*.txt'

function withCompanions(pathSet: Set<string>, files: string[]): void {
  if (!pathSet.has(PROGRAM_TS))
    return
  pathSet.add(CONTRACT_SURFACE)
  for (const file of expandGlob(CLI_HELP_GLOB, files))
    pathSet.add(file)
}

function withTests(pathSet: Set<string>, files: string[]): void {
  const tsPaths = [...pathSet].filter(path => path.endsWith('.ts'))
  for (const tsPath of tsPaths) {
    const segments = tsPath.split('/')
    const basename = segments[segments.length - 1]!.replace(/\.ts$/, '')
    for (const file of files) {
      if (file.startsWith(`tests/${basename}`) && file.endsWith('.test.ts'))
        pathSet.add(file)
    }
  }
}

function withoutImmutable(pathSet: Set<string>, immutable: string[]): Set<string> {
  const kept = new Set<string>()
  for (const path of pathSet) {
    const removed = immutable.includes(path) || immutable.some(item => item.endsWith('/') && path.startsWith(item))
    if (!removed)
      kept.add(path)
  }
  return kept
}

export function buildWriteSet(rawPaths: string[], files: string[], immutable: string[]): string[] {
  const pathSet = new Set(rawPaths)
  withCompanions(pathSet, files)
  withTests(pathSet, files)
  const final = withoutImmutable(pathSet, immutable)
  return [...final].sort()
}
