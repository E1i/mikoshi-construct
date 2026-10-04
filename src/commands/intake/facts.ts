import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { unresolvedCommandWord } from '../attach/harness.js'

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
const CURRENT_DIRECTORY_PREFIX = './'

export interface RepositoryFacts {
  exists: (relative: string) => boolean
  pathsNamed: (segment: string) => string[]
  commandResolves: (word: string) => boolean
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

function entriesOf(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
  }
  catch {
    return []
  }
}

export class DirectoryFacts implements RepositoryFacts {
  private walked: string[] | undefined

  constructor(private readonly root: string, private readonly searchPath: string) {}

  exists(relative: string): boolean {
    return existsSync(path.join(this.root, relative))
  }

  pathsNamed(segment: string): string[] {
    this.walked ??= this.walk('')
    return this.walked.filter(relative => path.posix.basename(relative) === segment).sort()
  }

  commandResolves(word: string): boolean {
    if (!word.includes('/'))
      return unresolvedCommandWord(word, this.searchPath) === null
    const relative = word.startsWith(CURRENT_DIRECTORY_PREFIX) ? word.slice(CURRENT_DIRECTORY_PREFIX.length) : word
    const file = path.resolve(this.root, relative)
    const inside = path.relative(this.root, file)
    return !path.isAbsolute(relative) && inside !== '' && !inside.startsWith('..') && isFile(file)
  }

  private walk(relative: string): string[] {
    return entriesOf(path.join(this.root, relative))
      .filter(entry => !SKIPPED_DIRECTORIES.has(entry.name))
      .flatMap((entry) => {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`
        return entry.isDirectory() ? [child, ...this.walk(child)] : [child]
      })
  }
}
