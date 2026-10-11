import type { ImportReading, Literal } from './scan.js'

export interface NamedFile {
  name: string
  line: number
}

export interface FileConstant {
  binding: string
  name: string
}

export const FILE_ACCESSES = ['writes', 'reads'] as const
export type Access = (typeof FILE_ACCESSES)[number]

export interface FileAccess {
  access: Access
  line: number
}

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises'])
const FUNCTIONS_BY_ACCESS: Record<Access, string[]> = {
  writes: ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream'],
  reads: ['readFileSync', 'readFile', 'createReadStream'],
}
const FILE_NAME = /^[\w.-]*[\w-]\.[a-z]\w*$/i
const EXPORTED_CONST = /\bexport\s+const\s+([A-Z_$][\w$]*)\s*(?::[^=]*)?=\s*$/i
const LOOKBEHIND = 200

function lineIndex(source: string): (offset: number) => number {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n')
      starts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (starts[middle] <= offset)
        low = middle
      else
        high = middle - 1
    }
    return low + 1
  }
}

export function fileNameOf(text: string): string | null {
  if (/\s/.test(text) || text.includes('://'))
    return null
  const tail = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('}')) + 1)
  return FILE_NAME.test(tail) ? tail : null
}

export function namedFiles(source: string, literals: Literal[]): NamedFile[] {
  const lineOf = lineIndex(source)
  return literals.flatMap((literal) => {
    const name = fileNameOf(literal.text)
    return name == null ? [] : [{ name, line: lineOf(literal.offset) }]
  })
}

export function fileConstants(strings: string, literals: Literal[]): FileConstant[] {
  return literals.flatMap((literal) => {
    const name = fileNameOf(literal.text)
    const binding = EXPORTED_CONST.exec(strings.slice(Math.max(0, literal.offset - LOOKBEHIND), literal.offset))?.[1]
    return name == null || binding === undefined ? [] : [{ binding, name }]
  })
}

function escaped(name: string): string {
  return name.replace(/\$/g, '\\$')
}

export function fileAccess(source: string, strings: string, imports: ImportReading[]): FileAccess[] {
  const lineOf = lineIndex(source)
  const found: FileAccess[] = []
  for (const reading of imports.filter(entry => FS_MODULES.has(entry.specifier))) {
    for (const access of FILE_ACCESSES) {
      const functions = FUNCTIONS_BY_ACCESS[access]
      for (const name of reading.bindings.filter(binding => functions.includes(binding))) {
        for (const match of strings.matchAll(new RegExp(`(?<![\\w$.])${escaped(name)}\\s*\\(`, 'g')))
          found.push({ access, line: lineOf(match.index ?? 0) })
      }
      for (const namespace of [...reading.bindings, ...reading.namespaces]) {
        for (const match of strings.matchAll(new RegExp(`(?<![\\w$.])${escaped(namespace)}\\s*\\.\\s*(${functions.join('|')})\\s*\\(`, 'g')))
          found.push({ access, line: lineOf(match.index ?? 0) })
      }
    }
  }
  return found.sort((left, right) => left.line - right.line || (left.access < right.access ? -1 : left.access > right.access ? 1 : 0))
}
