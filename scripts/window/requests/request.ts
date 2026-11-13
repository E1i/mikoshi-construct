import type { CloseOutcome, CloseRequest, DryRunRecord } from './reach.js'
import path from 'node:path'
import { BUS_REQUEST_COMMAND } from '../../core/owner-commands.js'
import { ANSWER_SOURCE, CARD_PLANNED, CARD_UNPLANNED, CLOSED_CARD, DROPPED_CARD, LEASED, MERGED_CARD, OWNER_MOVE_REQUESTS, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_OPENED, prOf, QUEUED, USED_WORD } from './reach.js'

export const REQUEST_KINDS = ['tree.cut', 'amend', 'allow-merge', 'close-pr', 'reopen-pr', 'pr.body', 'ci.rerun', 'requeue', 'mode', 'plan', 'owner.wait', 'owner.wait.close', 'decisions:add', 'hold', 'release', 'takeover', 'drop', 'numbers.foreign', 'owner.answer', ...OWNER_MOVE_REQUESTS] as const

export type RequestKind = typeof REQUEST_KINDS[number]

export type RequestPayload = Record<string, unknown>

export const HEAD_WORD = 'head'
export const TAKEOVER_AFTER_MINUTES = 30
export const PLAN_OPS: ReadonlyMap<string, string> = new Map([['open', PLAN_OPENED], ['add', CARD_PLANNED], ['remove', CARD_UNPLANNED], ['backfill', PLAN_BACKFILLED], ['close', PLAN_CLOSED]])
export const OWNER_WORD_NEEDED = `closing an owner wait needs the owner's word from the channel or a recorded decision`
export const OWNER_ANSWER_USAGE = `an owner's word from the channel closes a wait with: ${BUS_REQUEST_COMMAND} owner.wait.close --id Q<N> --answer <the owner's word> --from ${ANSWER_SOURCE}`
export const ENDED_CARDS: ReadonlySet<string | null | undefined> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])
export const LIVE_TASK_OF_CARD = `SELECT task_key, queue, state FROM tasks WHERE card_id = ? AND state IN ('${QUEUED}', '${LEASED}') ORDER BY id DESC LIMIT 1`

export interface CardTask { taskKey: string, cardId: number }

export interface Executed {
  done: boolean
  why: string
}

export interface RequestTools {
  treeOf: (cardId: number) => string
  exists: (dir: string) => boolean
  cutTree: (branch: string, cardLine: string) => void
  dryRunOf: (session: string) => DryRunRecord | null
  addDecision: (args: string[]) => { code: number, lines: string[] }
  causeHolds: (task: CardTask) => string | null
  closePr: (request: CloseRequest) => CloseOutcome
  closeDropped: () => CloseOutcome[]
  appendCountLine?: (pr: number, cardId: number) => Executed
  reopenPr?: (request: Omit<CloseRequest, 'by'>) => Executed
  appendBodyFile?: (attempt: string, pr: number, file: string) => Executed
  rerunCi?: (attempt: string, pr: number) => Executed
  settleDecisions?: () => void
}

export type RequestOutcome
  = | { kind: 'done', request: number, detail: string }
    | { kind: 'refused', request: number, detail: string }
    | { kind: 'owner', request: number, detail: string }

export function isRequestKind(kind: unknown): kind is RequestKind {
  return typeof kind === 'string' && (REQUEST_KINDS as readonly string[]).includes(kind)
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function noTool(what: string): Executed {
  return { done: false, why: `this bus was built with no tool to ${what}` }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function unreleasedWord(file: string): string {
  return `stays used though nothing was written; the owner renames ${file}${USED_WORD} back to ${path.basename(file)}`
}

export function flagsOf(name: string, values: unknown): string[] {
  return (Array.isArray(values) ? values : values === undefined ? [] : [values]).flatMap(value => [name, String(value)])
}

export function foreignIdsOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0)
    return null
  const ids = value.map(prOf)
  return ids.includes(null) ? null : ids as number[]
}
