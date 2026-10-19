import path from 'node:path'
import { covers } from './risk.js'
import { PREFIX_SUFFIX } from './task-file.js'

export interface SliceSources {
  read: (relative: string) => string | null
  filesUnder: (relative: string) => string[]
}

const RELATIVE_IMPORT = /\b(?:from|import(?:\s*\()?)\s*['"](\.{1,2}\/[^'"]+)['"]/g
const COMPILED_EXTENSION = /\.([cm]?)js$/

function filesOf(touch: string, sources: SliceSources): string[] {
  return touch.endsWith(PREFIX_SUFFIX) ? sources.filesUnder(touch.slice(0, -PREFIX_SUFFIX.length)) : [touch]
}

function importedPaths(file: string, sources: SliceSources): string[] {
  const text = sources.read(file)
  if (text === null)
    return []
  return [...text.matchAll(RELATIVE_IMPORT)].flatMap((match) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]!))
    return [target, target.replace(COMPILED_EXTENSION, '.$1ts')]
  })
}

export function sliceDepends(slices: readonly (readonly string[])[], sources: SliceSources): number[][] {
  const imported = slices.map(touches => touches.flatMap(touch => filesOf(touch, sources)).flatMap(file => importedPaths(file, sources)))
  return slices.map((_, index) => slices.flatMap((touches, at) => {
    const calls = at !== index && imported[index]!.some(target => touches.some(touch => covers(touch, target)))
    return calls ? [at] : []
  }))
}

export function dependsCycle(depends: readonly (readonly number[])[]): number[] | null {
  const walk = (index: number, trail: readonly number[]): number[] | null => {
    if (trail.includes(index))
      return trail.slice(trail.indexOf(index))
    for (const next of depends[index]!) {
      const cycle = walk(next, [...trail, index])
      if (cycle !== null)
        return cycle
    }
    return null
  }
  for (const index of depends.keys()) {
    const cycle = walk(index, [])
    if (cycle !== null)
      return cycle
  }
  return null
}
