import type { DatabaseSync } from 'node:sqlite'
import type { CardFields } from '../../intake/card-contract.js'
import type { Review } from './reviewer.js'
import { createHash } from 'node:crypto'
import { textSha } from '../../../src/card/text-sha.js'
import { appendCardEvent, laid } from '../../core/card-bodies.js'
import { inTransaction } from '../../core/db.js'
import { CARD_ADMITTED, NUMBERS_FOREIGN, PR_OPENED } from '../../core/events.js'
import { INTAKE_ACTOR_PREFIX } from '../../intake/admissions.js'
import { cardContract } from '../../intake/card-contract.js'
import { ANY, BusRead } from '../../ports/bus-read.js'
import { latestGitHubNumber } from './pr-close.js'

export const TAIL_SOURCE = 'review-tail'
export const TAIL_ACTOR = `${INTAKE_ACTOR_PREFIX}${TAIL_SOURCE}`
export const TAIL_PRIORITY = 'p1'
const TAIL_SUFFIX = '-tail'
const TAIL_SIZE = 'S'
const CARD_HEADER = 'card: '
const TOUCHES_HEADER = 'touches: '
const BODY_SHA_LENGTH = 12
const TEST_PATH = /(?:^|\/)(?:tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

export interface Tail {
  parent: number
  pr: number | null
  head: string | null
  taskKey: string
  findings: readonly string[]
}

export interface TailIntake {
  file: (tail: Tail) => number
}

export function mutationOnlyFindings(review: Review): string[] | null {
  if (review.verdict !== 'changes' || review.findings.length === 0)
    return null
  const marked = new Set((review.survivingMutations ?? []).map(finding => finding.trim()))
  return review.findings.every(finding => marked.has(finding.trim())) ? [...review.findings] : null
}

export function tailTouches(parent: Pick<CardFields, 'touches'>): string[] {
  const tests = parent.touches.filter(touch => TEST_PATH.test(touch))
  return tests.length > 0 ? tests : [...parent.touches]
}

export function tailOrigin(tail: Tail): string {
  return `Tail of card #${tail.parent}: the review of PR #${tail.pr ?? '—'} at ${tail.head ?? '—'}`
}

export function tailCardText(id: number, parent: CardFields, tail: Tail): string {
  const name = `${parent.name}${TAIL_SUFFIX}`
  return [
    `${CARD_HEADER}#${id} ${name} [implement/${parent.milestone}/${TAIL_SIZE}/cheap/auto] · depends — · blocks —`,
    `branch: feat/${name}`,
    `${TOUCHES_HEADER}${tailTouches(parent).join(', ')}`,
    `continue: ${parent.continue}`,
    `who: ${parent.who}`,
    `priority: ${TAIL_PRIORITY}`,
    '',
    `${tailOrigin(tail)} recorded pass because every finding was a surviving mutation (D-638). Kill each one with a test; the findings, word for word:`,
    '',
    ...tail.findings.map(finding => `- ${finding}`),
    '',
  ].join('\n')
}

export function tailBodySha(text: string): string {
  const lines = text.split('\n')
  const headerEnd = lines.findIndex(line => line.trim() === '')
  const header = headerEnd === -1 ? lines : lines.slice(0, headerEnd)
  const body = headerEnd === -1 ? '' : lines.slice(headerEnd).join('\n').trim()
  const touches = header.find(line => line.startsWith(TOUCHES_HEADER)) ?? ''
  return createHash('sha256').update(`${touches}\n${body}`).digest('hex').slice(0, BODY_SHA_LENGTH)
}

export interface HeldNumbers {
  cards: readonly number[]
  foreign: ReadonlySet<number>
  latestPr: number
}

export function nextTailNumber(held: HeldNumbers, onGitHub: number): number {
  const occupied = new Set(held.cards)
  let next = Math.max(0, ...held.cards.filter(id => !held.foreign.has(id)), held.latestPr, onGitHub) + 1
  while (occupied.has(next))
    next += 1
  return next
}

export function tailKey(taskKey: string): string {
  return `${CARD_ADMITTED}:${TAIL_SOURCE}:${taskKey}`
}

export interface BusTailParts {
  db: DatabaseSync
  gitHub: Parameters<typeof latestGitHubNumber>[0]
  clock: () => Date
}

export class BusTailIntake implements TailIntake {
  constructor(private readonly parts: BusTailParts) {}

  file(tail: Tail): number {
    const { db } = this.parts
    const filed = this.filedBefore(tail)
    if (filed !== null)
      return filed
    const parent = cardContract(db, tail.parent)
    if (parent === null)
      throw new Error(`card #${tail.parent} has no admitted body in the bus, so no tail card is filed`)
    const onGitHub = latestGitHubNumber(this.parts.gitHub)
    return inTransaction(db, () => {
      const id = nextTailNumber(this.heldNumbers(), onGitHub)
      const text = tailCardText(id, parent, tail)
      const line = text.split('\n')[0]!.slice(CARD_HEADER.length)
      if (!appendCardEvent(db, TAIL_ACTOR, laid(db, { type: CARD_ADMITTED, cardId: id, ts: this.parts.clock().toISOString(), dedupeKey: tailKey(tail.taskKey), payload: { card: line, lane: null, depends: [], decision: 'auto', contour: 'cheap', confirmation: 'auto', corrections: [], bodySha: tailBodySha(text), text, textSha: textSha(text), source: TAIL_SOURCE } })))
        throw new Error(`the card.admitted of tail card #${id} was not appended`)
      return id
    })
  }

  private heldNumbers(): HeldNumbers {
    const read = new BusRead(this.parts.db)
    const cards = read.where({ card: ANY }).slice(CARD_ADMITTED, [], 'last-per-card').flatMap(event => event.card === null ? [] : [event.card])
    const foreign = new Set(read.slice(NUMBERS_FOREIGN, ['ids']).flatMap(event => Array.isArray(event.fields.ids) ? event.fields.ids.map(Number) : []))
    return { cards, foreign, latestPr: this.latestPrInTheBus() }
  }

  private filedBefore(tail: Tail): number | null {
    const origin = `\n${tailOrigin(tail)} `
    const filed = new BusRead(this.parts.db).where({ actor: TAIL_ACTOR }).slice(CARD_ADMITTED, ['text']).find(event => String(event.fields.text ?? '').includes(origin))
    return filed?.card ?? null
  }

  private latestPrInTheBus(): number {
    return new BusRead(this.parts.db).where({ pr: ANY }).slice(PR_OPENED, [], 'last')[0]?.pr ?? 0
  }
}
