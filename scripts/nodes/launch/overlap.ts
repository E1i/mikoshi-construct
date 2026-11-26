import type { ShiftTask } from '../../../src/card/task-file.js'
import { touchesWithoutRuns } from '../../../src/card/covering-tests.js'
import { PREFIX_SUFFIX } from '../../policy/touch-scope.js'
import { sharedAppendFiles } from './shared-files.js'

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

function inSharedClass(entry: string, shared: readonly string[]): boolean {
  return shared.some(declared => declared === entry || covers(declared, entry))
}

function taskRelation(a: string, b: string, shared: readonly string[]): string | null {
  if (inSharedClass(a, shared) && inSharedClass(b, shared))
    return null
  return isAdditive(a) && isAdditive(b) && (isMask(a) || isMask(b)) ? null : relation(a, b)
}

function pairs<T>(items: readonly T[]): [T, T][] {
  return items.flatMap((first, index) => items.slice(index + 1).map(second => [first, second] as [T, T]))
}

export function taskConflicts(tasks: readonly ShiftTask[], shared: readonly string[] = []): string[] {
  return pairs(tasks).flatMap(([a, b]) => {
    const head = `${a.file} × ${b.file}: `
    const same = [
      ...(a.id === b.id ? [`${head}task ${a.id} twice`] : []),
      ...(a.branch === b.branch ? [`${head}branch ${a.branch} twice`] : []),
    ]
    const touched = touchesWithoutRuns(a.touches, a.body).flatMap(left => touchesWithoutRuns(b.touches, b.body).flatMap((right) => {
      const sign = taskRelation(left, right, shared)
      return sign === null ? [] : [`${head}${left} ${sign} ${right}`]
    }))
    return [...same, ...touched]
  })
}

export type Narrowing = (task: ShiftTask) => ShiftTask

export function overlapPath(task: ShiftTask | null, other: ShiftTask | null, shared: readonly string[], narrow: Narrowing): string | null {
  if (task === null || other === null)
    return null
  const meets = (touches: string[]): boolean => taskConflicts([narrow(other), narrow({ ...task, touches })], shared).length > 0
  if (!meets(task.touches))
    return null
  return task.touches.find(touch => meets([touch])) ?? task.touches[0]!
}

export interface Contender {
  cardId: number
  priority: string | null
  task: ShiftTask | null
}

export interface Overlap<H extends Contender> {
  holder: H
  path: string
}

export type Yields<H extends Contender> = (holder: H, claimant: Contender) => boolean

export class OverlapVerdict<H extends Contender> {
  private readonly held = new Map<number, Overlap<H>>()
  private readonly taken: H[]

  constructor(holding: readonly H[], private readonly holds: Yields<H>, private readonly shared: readonly string[], private readonly narrow: Narrowing) {
    this.taken = [...holding]
  }

  get holding(): readonly H[] {
    return this.taken
  }

  against(card: Contender): Overlap<H> | null {
    for (const holder of this.taken) {
      if (holder.cardId === card.cardId || !this.holds(holder, card))
        continue
      const path = overlapPath(card.task, holder.task, this.shared, this.narrow)
      if (path !== null)
        return { holder, path }
    }
    return null
  }

  claim(card: Contender, holder: H | null): Overlap<H> | null {
    const overlap = this.against(card)
    if (overlap !== null)
      this.held.set(card.cardId, overlap)
    else if (holder !== null)
      this.taken.push(holder)
    return overlap
  }

  of(cardId: number): Overlap<H> | null {
    return this.held.get(cardId) ?? null
  }

  on(card: Contender): Overlap<H> | null {
    return this.of(card.cardId) ?? this.against(card)
  }
}

export type OverlapHold
  = { kind: 'open-pr', pr: number, cardId: number, path: string }
    | { kind: 'session', cardId: number, path: string }

export function overlapHold({ holder, path }: Overlap<Contender>, openPrs: ReadonlyMap<number, number>): OverlapHold {
  const pr = openPrs.get(holder.cardId)
  return pr === undefined ? { kind: 'session', cardId: holder.cardId, path } : { kind: 'open-pr', pr, cardId: holder.cardId, path }
}

export function openPrWarnings(tasks: readonly ShiftTask[], prs: readonly OpenPr[], shared: readonly string[] = sharedAppendFiles()): string[] {
  return tasks.flatMap(task => prs.flatMap(pr => task.touches
    .filter(entry => pr.files.some(file => taskRelation(entry, file, shared) !== null))
    .map(entry => `${task.file} × PR #${pr.number}: ${entry}`)))
}
