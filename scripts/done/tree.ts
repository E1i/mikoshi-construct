import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isReadExtension } from './wiring.js'

export interface Tree {
  files: Set<string>
  addedLines: (file: string, start: number, end: number) => boolean
  read: (file: string) => string
}

type Ranges = Array<[number, number]>

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  }
  catch (error) {
    throw new Error(`git ${args[0]} failed: ${String((error as Error).message).split('\n').find(line => line.length > 0 && !line.startsWith('Command failed')) ?? 'no reason'}`)
  }
}

function listed(root: string, args: string[]): string[] {
  return git(root, ['ls-files', '-z', ...args]).split('\0').filter(file => file.length > 0)
}

function exists(root: string, file: string): boolean {
  try {
    lstatSync(path.join(root, file))
    return true
  }
  catch {
    return false
  }
}

const C_ESCAPES: Record<string, number> = { 'a': 7, 'b': 8, 't': 9, 'n': 10, 'v': 11, 'f': 12, 'r': 13, '"': 34, '\\': 92 }
const C_QUOTED_PART = /\\([0-7]{3}|.)|[^\\]+/gs

function unquoted(header: string): string {
  if (header.length < 2 || !header.startsWith('"') || !header.endsWith('"'))
    return header
  const bytes = [...header.slice(1, -1).matchAll(C_QUOTED_PART)].flatMap(([part, escape]) => {
    if (escape === undefined)
      return [...Buffer.from(part, 'utf8')]
    return [escape.length === 3 ? Number.parseInt(escape, 8) : C_ESCAPES[escape] ?? escape.charCodeAt(0)]
  })
  return Buffer.from(bytes).toString('utf8')
}

function addedRanges(diff: string): Map<string, Ranges> {
  const ranges = new Map<string, Ranges>()
  let current: Ranges | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = unquoted(line.slice(4).replace(/\t$/, ''))
      current = target === '/dev/null' ? undefined : []
      if (current !== undefined)
        ranges.set(target.replace(/^b\//, ''), current)
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk !== null && current !== undefined) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      if (count > 0)
        current.push([start, start + count - 1])
    }
  }
  return ranges
}

export function readTree(root: string, base: string): Tree {
  git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  const untracked = new Set(listed(root, ['--others', '--exclude-standard']))
  const files = new Set([...listed(root, ['--cached', '--others', '--exclude-standard'])].filter(file => exists(root, file)))
  const ranges = addedRanges(git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', base, '--']))
  const texts = new Map<string, string>()
  const read = (file: string): string => {
    let text = texts.get(file)
    if (text === undefined) {
      text = readFileSync(path.join(root, file), 'utf8')
      texts.set(file, text)
    }
    return text
  }
  for (const file of files) {
    if (isReadExtension(file))
      read(file)
  }
  return {
    files,
    read,
    addedLines: (file, start, end) => {
      if (untracked.has(file))
        return true
      return (ranges.get(file) ?? []).some(([from, to]) => from <= end && to >= start)
    },
  }
}
