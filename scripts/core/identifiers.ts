import { isFullSha, positiveInteger } from '../ports/identifier-shapes.js'

export const HEAVY_RUNS = ['quality', 'vitest'] as const
export type HeavyRun = typeof HEAVY_RUNS[number]

export const QUEUES = ['review', 'update', 'merge', 'answer', 'launch', 'restart', 'close', 'witness', ...HEAVY_RUNS] as const
export type Queue = typeof QUEUES[number]

export const REVIEW_ROUNDS = 3
export const BACKFILL_SOURCE = 'backfill'
export const A_CARD_DECISION_REOPENS = 'card_decision'

const DECISION_SUFFIX = /:decision-([1-9]\d*)$/
const KEYED_ON_THE_CARD_DECISION: readonly Queue[] = ['merge', 'update']
const DECIDED_QUEUES: readonly Queue[] = ['answer', ...KEYED_ON_THE_CARD_DECISION]

export interface BoundDecision {
  decisionId: number
  cards: readonly number[]
}

export function decisionSegment(task: { queue: Queue, decision?: number }): string {
  if (task.decision === undefined)
    return ''
  if (!DECIDED_QUEUES.includes(task.queue) || !Number.isSafeInteger(task.decision) || task.decision < 1)
    throw new Error(`only an answer task carries a decision id, or a merge or an update task the card's decision withdraws: ${task.queue}, ${task.decision}`)
  return `:decision-${task.decision}`
}

export function decisionOfKey(key: unknown): number | undefined {
  const match = typeof key === 'string' ? DECISION_SUFFIX.exec(key) : null
  return match === null ? undefined : Number(match[1])
}

export function answerDecisionOfKey(queue: Queue, key: unknown): number | undefined {
  return queue === 'answer' ? decisionOfKey(key) : undefined
}

export function decidedTaskDecisionOfKey(queue: Queue, key: unknown): number | undefined {
  return DECIDED_QUEUES.includes(queue) ? decisionOfKey(key) : undefined
}

export function latestCardDecision(decisions: readonly BoundDecision[], cardId: number): number | undefined {
  return decisions.filter(decision => decision.cards.includes(cardId)).reduce<number | undefined>((latest, decision) => Math.max(latest ?? 0, decision.decisionId), undefined)
}

export function cardDecisionKeyOf(queue: Queue, cardId: number, decisions: () => readonly BoundDecision[]): number | undefined {
  return KEYED_ON_THE_CARD_DECISION.includes(queue) ? latestCardDecision(decisions(), cardId) : undefined
}

export function tasksTheHeadOrTheCardDecisionSupersedes<Row extends { head_moved: unknown }>(rows: readonly Row[], decisions: readonly BoundDecision[], identityOf: (row: Row) => { queue: Queue, cardId: number, decision?: number }): Row[] {
  return rows.filter((row) => {
    const task = identityOf(row)
    return row.head_moved === 1 || (KEYED_ON_THE_CARD_DECISION.includes(task.queue) && task.decision !== latestCardDecision(decisions, task.cardId))
  })
}

const FIXED_ACTORS = new Set(['netwatch', 'reducer', 'owner', 'policy'])
const WORKER_ACTOR = /^worker:[a-z][a-z-]*:[^:\s]+$/
const BODY_SHA = /^[0-9a-f]{8,64}$/
const NO_CARD_BODY = '-'
const REVIEW_INPUT = /:pr-body-([0-9a-f]{8,64}):card-body-([0-9a-f]{8,64}|-)$/

export interface ReviewInput {
  prBody: string
  cardBody: string | null
}

export interface TaskIdentity {
  queue: Queue
  cardId: number
  pr?: number
  head?: string
  generation?: string
  input?: ReviewInput
}

export function isActor(value: string): boolean {
  return FIXED_ACTORS.has(value) || WORKER_ACTOR.test(value)
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
  if (task.generation !== undefined && (task.generation === '' || task.pr !== undefined || task.head !== undefined))
    throw new Error(`a generation names a task with no pr and no head: ${task.generation}`)
  if (task.generation !== undefined)
    return `${task.queue}:${task.cardId}:${task.generation}`
  const plain = `${task.queue}:${task.cardId}:${task.pr ?? '-'}:${task.head ?? '-'}`
  return task.input === undefined ? plain : `${plain}${inputSuffix(task, task.input)}`
}

function inputSuffix(task: TaskIdentity, input: ReviewInput): string {
  if (task.queue !== 'review' || task.pr === undefined || task.head === undefined)
    throw new Error(`only a review task of a pull request head carries a review input: ${task.queue}`)
  if (!BODY_SHA.test(input.prBody) || (input.cardBody !== null && !BODY_SHA.test(input.cardBody)))
    throw new Error(`a review input is a pull request body sha and a card body sha: ${input.prBody}, ${input.cardBody}`)
  return `:pr-body-${input.prBody}:card-body-${input.cardBody ?? NO_CARD_BODY}`
}

export function reviewInputOf(prBody: string | null, cardBody: unknown): ReviewInput | undefined {
  if (prBody === null || !BODY_SHA.test(prBody))
    return undefined
  return { prBody, cardBody: typeof cardBody === 'string' && BODY_SHA.test(cardBody) ? cardBody : null }
}

export function reviewInputOfKey(key: unknown): ReviewInput | undefined {
  const match = typeof key === 'string' ? REVIEW_INPUT.exec(key) : null
  return match === null ? undefined : { prBody: match[1]!, cardBody: match[2] === NO_CARD_BODY ? null : match[2]! }
}

const GENERATION_QUEUES: readonly Queue[] = ['launch', ...HEAVY_RUNS]

export function generationOfKey(key: string, task: Omit<TaskIdentity, 'generation' | 'input'>): string | undefined {
  const plain = taskKey(task)
  const prefix = `${task.queue}:${task.cardId}:`
  return !GENERATION_QUEUES.includes(task.queue) || key === plain || !key.startsWith(prefix) || task.pr !== undefined || task.head !== undefined ? undefined : key.slice(prefix.length)
}
