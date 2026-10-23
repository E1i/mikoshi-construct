import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type NameSource = 'package.json' | 'README' | 'folder' | 'none'
export type DescriptionSource = 'package.json' | 'README'

export interface Sourced<Source> {
  text: string
  from: Source
}

export interface RepoIdentity {
  name: Sourced<NameSource>
  description?: Sourced<DescriptionSource>
}

interface RepoFiles {
  root: string
  manifest: Record<string, unknown> | null
  readme: string | null
}

type Adapter<Source> = (files: RepoFiles) => Sourced<Source> | null

export const UNKNOWN_REPO = 'unknown repo'

const README_FILE = /^readme(?:\.(?:md|markdown|txt))?$/i
const TOP_HEADING = '# '
const CLOSING_HASHES = /#+$/
const NOT_PROSE = /^(?:[#<|>]|!\[|\[!\[|```|---|===)/

function readText(file: string): string | null {
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null
}

function readManifest(root: string): Record<string, unknown> | null {
  const text = readText(path.join(root, 'package.json'))
  if (text == null)
    return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed != null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

function readReadme(root: string): string | null {
  if (!existsSync(root) || !statSync(root).isDirectory())
    return null
  const file = readdirSync(root).sort().find(entry => README_FILE.test(entry))
  return file == null ? null : readText(path.join(root, file))
}

function manifestField(field: string): Adapter<'package.json'> {
  return ({ manifest }) => {
    const value = manifest?.[field]
    return typeof value === 'string' && value.trim() !== '' ? { text: value.trim(), from: 'package.json' } : null
  }
}

const readmeHeading: Adapter<'README'> = ({ readme }) => {
  const line = (readme ?? '').split('\n').find(candidate => candidate.startsWith(TOP_HEADING))
  const heading = line?.slice(TOP_HEADING.length).trim().replace(CLOSING_HASHES, '').trim()
  return heading == null || heading === '' ? null : { text: heading, from: 'README' }
}

const readmeParagraph: Adapter<'README'> = ({ readme }) => {
  const paragraph = (readme ?? '')
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .find(block => block !== '' && !NOT_PROSE.test(block))
  return paragraph == null ? null : { text: paragraph.split('\n').map(line => line.trim()).join(' '), from: 'README' }
}

const folderName: Adapter<'folder'> = ({ root }) => {
  const name = path.basename(root)
  return name === '' ? null : { text: name, from: 'folder' }
}

const NAME_ADAPTERS: Adapter<NameSource>[] = [manifestField('name'), readmeHeading, folderName]
const DESCRIPTION_ADAPTERS: Adapter<DescriptionSource>[] = [manifestField('description'), readmeParagraph]

function firstOf<Source>(adapters: Adapter<Source>[], files: RepoFiles): Sourced<Source> | null {
  for (const adapter of adapters) {
    const found = adapter(files)
    if (found != null)
      return found
  }
  return null
}

export function repoIdentity(root: string): RepoIdentity {
  const files: RepoFiles = { root: path.resolve(root), manifest: readManifest(root), readme: readReadme(root) }
  const name = firstOf(NAME_ADAPTERS, files) ?? { text: UNKNOWN_REPO, from: 'none' }
  const description = firstOf(DESCRIPTION_ADAPTERS, files)
  return description == null ? { name } : { name, description }
}
