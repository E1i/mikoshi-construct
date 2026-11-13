import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendEvent, openBus } from '../core/db.js'
import { declaredPayload, WINDOW_REQUEST } from '../core/events.js'
import { storedByKey } from '../core/stored.js'
import { sayToOwnerChannel } from './channel.js'

export const ANSWER_SESSION = 'owner-answer'
export const ANSWER_ACTOR = `worker:window:${ANSWER_SESSION}`
export const ANSWER_FROM = 'answer'
export const ANSWER_WORD = 'answer'
const A_WAIT = /^Q\d+$/
const A_CARD = /^#?([1-9]\d*)$/
const A_FLAG = '--'

export type AnswerTarget = { id: string } | { card: number }

export interface OwnerAnswer {
  target: AnswerTarget
  label: string
  words: string
}

export interface AnswerRequest {
  request: number
  label: string
}

export function answerWord(target: string, words: string): string {
  return `${ANSWER_WORD} ${target}: ${words}`
}

function targetOf(named: string): AnswerTarget | null {
  if (A_WAIT.test(named))
    return { id: named }
  const card = A_CARD.exec(named)
  return card === null ? null : { card: Number(card[1]) }
}

export function ownerAnswerOf(named: string | undefined, said: string | undefined): OwnerAnswer | null {
  const target = named === undefined ? null : targetOf(named)
  const words = said?.trim() ?? ''
  if (target === null || words === '' || words.startsWith(A_FLAG))
    return null
  return { target, label: 'id' in target ? target.id : `#${target.card}`, words }
}

export function writeAnswerRequest(db: DatabaseSync, channel: string, answer: OwnerAnswer, now: Date): AnswerRequest {
  sayToOwnerChannel(channel, answerWord(answer.label, answer.words), now)
  const ts = now.toISOString()
  const dedupeKey = `${WINDOW_REQUEST}:${ANSWER_SESSION}:${ts}:${randomUUID()}`
  const payload = declaredPayload(WINDOW_REQUEST, { kind: 'owner.answer', ...answer.target, text: answer.words, from: ANSWER_FROM })
  appendEvent(db, { ts, type: WINDOW_REQUEST, actor: ANSWER_ACTOR, cardId: 'card' in answer.target ? answer.target.card : null, pr: null, head: null, dedupeKey, payload, legacy: false })
  return { request: storedByKey(db, dedupeKey).id, label: answer.label }
}

export function requestOwnerAnswer(busPath: string, channel: string, answer: OwnerAnswer, now: Date): AnswerRequest | null {
  if (!existsSync(busPath))
    return null
  const db = openBus(busPath)
  try {
    return writeAnswerRequest(db, channel, answer, now)
  }
  finally {
    db.close()
  }
}
