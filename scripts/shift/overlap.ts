import type { ShiftTask } from '../../src/card/task-file.js'
import { PREFIX_SUFFIX } from '../../src/card/task-file.js'

export interface OpenPr {
  number: number
  headRefName: string
  files: string[]
}

function scopeOf(entry: string): { path: string, prefix: boolean } {
  return entry.endsWith(PREFIX_SUFFIX) ? { path: entry.slice(0, -PREFIX_SUFFIX.length), prefix: true } : { path: entry, prefix: false }
}

function covers(outer: string, inner: string): boolean {
  const scope = scopeOf(outer)
  const target = scopeOf(inner).path
  return scope.prefix && (target === scope.path || target.startsWith(`${scope.path}/`))
}

export function relation(a: string, b: string): string | null {
  if (a === b)
    return '='
  if (covers(a, b))
    return '⊃'
  if (covers(b, a))
    return '⊂'
  return null
}

const ADDITIVE_ROOTS = ['tests', 'scripts/tests', '.changeset']

function isAdditive(entry: string): boolean {
  const { path } = scopeOf(entry)
  return ADDITIVE_ROOTS.some(root => path === root || path.startsWith(`${root}/`))
}

function isMask(entry: string): boolean {
  return scopeOf(entry).prefix
}

function taskRelation(a: string, b: string): string | null {
  return isAdditive(a) && isAdditive(b) && (isMask(a) || isMask(b)) ? null : relation(a, b)
}

function pairs<T>(items: readonly T[]): [T, T][] {
  return items.flatMap((first, index) => items.slice(index + 1).map(second => [first, second] as [T, T]))
}

export function taskConflicts(tasks: readonly ShiftTask[]): string[] {
  return pairs(tasks).flatMap(([a, b]) => {
    const head = `${a.file} × ${b.file}: `
    const same = [
      ...(a.id === b.id ? [`${head}task ${a.id} twice`] : []),
      ...(a.branch === b.branch ? [`${head}branch ${a.branch} twice`] : []),
    ]
    const touched = a.touches.flatMap(left => b.touches.flatMap((right) => {
      const sign = taskRelation(left, right)
      return sign === null ? [] : [`${head}${left} ${sign} ${right}`]
    }))
    return [...same, ...touched]
  })
}

export function openPrWarnings(tasks: readonly ShiftTask[], prs: readonly OpenPr[]): string[] {
  return tasks.flatMap(task => prs.flatMap(pr => task.touches
    .filter(entry => pr.files.some(file => relation(entry, file) !== null))
    .map(entry => `${task.file} × PR #${pr.number}: ${entry}`)))
}
