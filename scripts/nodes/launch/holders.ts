import type { Priority } from '../../../src/card/parking.js'
import type { ShiftTask } from '../../../src/card/task-file.js'
import { PRIORITIES } from '../../../src/card/parking.js'

export interface Claimant {
  cardId: number
  priority: Priority | null
}

export interface Holder extends Claimant {
  lane: string | null
  depends: number[]
  task: ShiftTask | null
  ownerHeld: boolean
}

const UNCLEAR_LINE = /^unclear:[ \t]*(\S.*)$/m

function rankOf(priority: Priority | null): number {
  return priority === null ? PRIORITIES.length : PRIORITIES.indexOf(priority)
}

function yieldsTo(holder: Holder, claimant: Claimant): boolean {
  return holder.ownerHeld && rankOf(claimant.priority) < rankOf(holder.priority)
}

export function holdsAgainst(holder: Holder, claimant: Claimant): boolean {
  return holder.cardId !== claimant.cardId && !yieldsTo(holder, claimant)
}

export function holderOf(card: Omit<Holder, 'task' | 'ownerHeld'>, task: ShiftTask | null, ownerHeld: boolean): Holder {
  return { cardId: card.cardId, lane: card.lane, depends: card.depends, priority: card.priority, task, ownerHeld }
}

export function observedDiff(payload: Record<string, unknown>): string[] | null {
  const diff = Array.isArray(payload.paths) ? payload.paths.filter((each): each is string => typeof each === 'string') : []
  return diff.length === 0 || payload.pathsTruncated === true ? null : diff
}

export function withDiff(task: ShiftTask | null, diff: string[] | null): ShiftTask | null {
  return task === null || diff === null ? task : { ...task, touches: diff }
}

export function unclearField(task: ShiftTask | null): string | null {
  return task === null ? null : UNCLEAR_LINE.exec(task.body)?.[1]?.trim() ?? null
}
