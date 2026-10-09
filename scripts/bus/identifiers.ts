export const QUEUES = ['review', 'update', 'merge', 'answer', 'launch', 'restart', 'close'] as const
export type Queue = typeof QUEUES[number]

const FIXED_ACTORS = new Set(['netwatch', 'reducer', 'owner', 'policy'])
const WORKER_ACTOR = /^worker:[a-z][a-z-]*:[^:\s]+$/
const FULL_SHA = /^[0-9a-f]{40}$/
const LEADING_NUMBER = /^#?(\d+)(?!\d)/

export interface TaskIdentity {
  queue: Queue
  cardId: number
  pr?: number
  head?: string
}

export function isActor(value: string): boolean {
  return FIXED_ACTORS.has(value) || WORKER_ACTOR.test(value)
}

export function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA.test(value)
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function cardIdOf(value: unknown): number | null {
  if (typeof value === 'number')
    return positiveInteger(value)
  if (typeof value === 'string') {
    const match = LEADING_NUMBER.exec(value.trim())
    return match === null ? null : positiveInteger(Number(match[1]))
  }
  if (value !== null && typeof value === 'object' && 'id' in value)
    return cardIdOf((value as { id: unknown }).id)
  return null
}

export function prOf(value: unknown): number | null {
  return positiveInteger(value)
}

export function taskKey(task: TaskIdentity): string {
  if (!QUEUES.includes(task.queue))
    throw new Error(`unknown queue: ${task.queue}`)
  if (positiveInteger(task.cardId) === null)
    throw new Error(`card_id is not a positive integer: ${task.cardId}`)
  if (task.pr !== undefined && prOf(task.pr) === null)
    throw new Error(`pr is not a positive integer: ${task.pr}`)
  if (task.head !== undefined && !isFullSha(task.head))
    throw new Error(`head is not a full sha: ${task.head}`)
  return `${task.queue}:${task.cardId}:${task.pr ?? '-'}:${task.head ?? '-'}`
}
