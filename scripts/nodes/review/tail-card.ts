import type { DatabaseSync } from 'node:sqlite'
import type { Review } from './reviewer.js'
import { createHash } from 'node:crypto'
import { appendCardEvent, cardBodyText, laid } from '../../core/card-bodies.js'
import { inTransaction } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { latestGitHubNumber } from './pr-close.js'

export const TAIL_SOURCE = 'review-tail'
export const TAIL_ACTOR = `worker:intake:${TAIL_SOURCE}`
export const TAIL_PRIORITY = 'p1'
const TAIL_SUFFIX = '-tail'
const TAIL_SIZE = 'S'
const CARD_HEADER = 'card: '
const TOUCHES_HEADER = 'touches: '
const BODY_SHA_LENGTH = 12
const TEST_PATH = /(?:^|\/)(?:tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const CARD_LINE = /^#\d+\s+(\S+)\s+\[[^/\]]+\/([^/\]]+)\//
const HEADER_LINE = /^([a-z]+):(.*)$/

export interface Tail {
  parent: number
  pr: number | null
  head: string | null
  taskKey: string
  findings: readonly string[]
}

export interface TailIntake {
  file: (tail: Tail) => void
}

export interface TailParent {
  name: string
  milestone: string
  continue: string
  who: string
  touches: readonly string[]
}

export function mutationOnlyFindings(review: Review): string[] | null {
  if (review.verdict !== 'changes' || review.findings.length === 0)
    return null
  const marked = new Set((review.survivingMutations ?? []).map(finding => finding.trim()))
  return review.findings.every(finding => marked.has(finding.trim())) ? [...review.findings] : null
}

function headerOf(text: string): Map<string, string> {
  const lines = text.split('\n')
  const end = lines.findIndex(line => line.trim() === '')
  return new Map((end === -1 ? lines : lines.slice(0, end)).flatMap((line) => {
    const match = HEADER_LINE.exec(line.trim())
    return match === null ? [] : [[match[1]!, match[2]!.trim()] as [string, string]]
  }))
}

export function tailParentOf(text: string): TailParent | null {
  const header = headerOf(text)
  const line = CARD_LINE.exec(header.get('card') ?? '')
  const touches = (header.get('touches') ?? '').split(',').map(touch => touch.trim()).filter(touch => touch !== '')
  if (line === null || touches.length === 0)
    return null
  return { name: line[1]!, milestone: line[2]!, continue: header.get('continue') ?? 'stop', who: header.get('who') ?? 'shift', touches }
}

export function tailTouches(parent: Pick<TailParent, 'touches'>): string[] {
  const tests = parent.touches.filter(touch => TEST_PATH.test(touch))
  return tests.length > 0 ? tests : [...parent.touches]
}

export function tailOrigin(tail: Tail): string {
  return `Tail of card #${tail.parent}: the review of PR #${tail.pr ?? '—'} at ${tail.head ?? '—'}`
}

export function tailCardText(id: number, parent: TailParent, tail: Tail): string {
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

export function tailTextSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function tailBodySha(text: string): string {
  const lines = text.split('\n')
  const headerEnd = lines.findIndex(line => line.trim() === '')
  const header = headerEnd === -1 ? lines : lines.slice(0, headerEnd)
  const body = headerEnd === -1 ? '' : lines.slice(headerEnd).join('\n').trim()
  const touches = header.find(line => line.startsWith(TOUCHES_HEADER)) ?? ''
  return createHash('sha256').update(`${touches}\n${body}`).digest('hex').slice(0, BODY_SHA_LENGTH)
}

export interface HeldCards {
  keys: () => Iterable<string>
  readonly foreign?: ReadonlySet<number>
}

export function nextTailNumber(held: HeldCards, outsideTheBus: readonly number[]): number {
  const cards = [...held.keys()].flatMap(key => /^\d+$/.test(key) ? [Number(key)] : [])
  const occupied = new Set(cards)
  let next = Math.max(0, ...cards.filter(id => held.foreign?.has(id) !== true), ...outsideTheBus) + 1
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
  cardStates: () => HeldCards
}

export class BusTailIntake implements TailIntake {
  constructor(private readonly parts: BusTailParts) {}

  file(tail: Tail): void {
    const { db } = this.parts
    const body = cardBodyText(db, tail.parent)
    const parent = body === null ? null : tailParentOf(body)
    if (parent === null)
      throw new Error(`card #${tail.parent} has no admitted body in the bus, so no tail card is filed`)
    const onGitHub = latestGitHubNumber(this.parts.gitHub)
    inTransaction(db, () => {
      const id = nextTailNumber(this.parts.cardStates(), [tail.pr ?? 0, onGitHub])
      const text = tailCardText(id, parent, tail)
      const line = text.split('\n')[0]!.slice(CARD_HEADER.length)
      appendCardEvent(db, TAIL_ACTOR, laid(db, { type: CARD_ADMITTED, cardId: id, ts: this.parts.clock().toISOString(), dedupeKey: tailKey(tail.taskKey), payload: { card: line, lane: null, depends: [], decision: 'auto', contour: 'cheap', confirmation: 'auto', corrections: [], bodySha: tailBodySha(text), text, textSha: tailTextSha(text), source: TAIL_SOURCE } }))
    })
  }
}
