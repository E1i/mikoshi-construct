import type { NamedFunction } from './syntax.js'
import type { Tree } from './tree.js'
import { namedFunctions, parse } from './syntax.js'
import { isSource } from './wiring.js'

export interface Citation {
  file: string
  line: number
}

export interface CheckedFunction extends NamedFunction {
  file: string
}

function enclosing(functions: NamedFunction[], line: number): NamedFunction | undefined {
  return functions
    .filter(fn => fn.startLine <= line && line <= fn.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0]
}

export function checkedFunctions(tree: Tree, citations: Citation[]): CheckedFunction[] {
  const checked = new Map<string, CheckedFunction>()
  const add = (file: string, fn: NamedFunction | undefined): void => {
    if (fn !== undefined)
      checked.set(`${file}:${fn.nameStart}`, { ...fn, file })
  }
  const sources = [...tree.files].filter(isSource)
  for (const file of sources) {
    const functions = namedFunctions(parse(file, tree.read(file)))
    for (const fn of functions) {
      if (tree.addedLines(file, fn.startLine, fn.endLine))
        add(file, fn)
    }
    for (const citation of citations.filter(cited => cited.file === file))
      add(file, enclosing(functions, citation.line))
  }
  return [...checked.values()].sort(byPosition)
}

export function byPosition(a: { file: string, nameLine: number }, b: { file: string, nameLine: number }): number {
  if (a.file !== b.file)
    return a.file < b.file ? -1 : 1
  return a.nameLine - b.nameLine
}
