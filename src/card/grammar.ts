import { MILESTONES } from './milestones.js'

export const KINDS = ['implement', 'probe'] as const
export const SIZES = ['XS', 'S', 'M', 'L'] as const
export const CONTOURS = ['cheap', 'ladder'] as const
export const DECISIONS = ['owner', 'auto', 'none'] as const
export const CARD_GRAMMAR = '#<id> <name> [<kind>/<milestone>/<size>/<contour>/<decision>] · depends <#id …|—> · blocks <#id …|—>'

const DECISIONS_OF_KIND: Record<Kind, readonly Decision[]> = { implement: ['owner', 'auto'], probe: ['none'] }
const HEAD = /^#(\S+) (\S+) \[([^\]]*)\](.*)$/
const ID = /^\d+$/
const NAME = /^[a-z0-9-]+$/
const NONE = '—'
const DEPENDS = ' · depends '
const BLOCKS = ' · blocks '
const LEADING_IDS = /^#\d+(?:,? #\d+)*/

export type Kind = typeof KINDS[number]
export type Milestone = typeof MILESTONES[number]
export type Size = typeof SIZES[number]
export type Contour = typeof CONTOURS[number]
export type Decision = typeof DECISIONS[number]

export interface Card {
  id: number
  name: string
  kind: Kind
  milestone: Milestone
  size: Size
  contour: Contour
  decision: Decision
  depends: number[]
  blocks: number[]
  line: string
}

export type ParsedCard = { kind: 'card', card: Card } | { kind: 'refused', reason: string }

function refused(reason: string): ParsedCard {
  return { kind: 'refused', reason }
}

function oneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value)
}

function idsOf(text: string): number[] {
  return [...text.matchAll(/#(\d+)/g)].map(match => Number(match[1]))
}

function readDepends(value: string): number[] | null {
  if (value === NONE)
    return []
  return LEADING_IDS.exec(value)?.[0] === value ? idsOf(value) : null
}

function readBlocks(value: string): number[] | null {
  if (value === NONE || value.startsWith(`${NONE} `))
    return []
  const ids = LEADING_IDS.exec(value)?.[0]
  if (ids === undefined || (ids !== value && !value.startsWith(`${ids} `)))
    return null
  return idsOf(ids)
}

export function cardHead(card: Omit<Card, 'line'>): string {
  return `#${card.id} ${card.name} [${card.kind}/${card.milestone}/${card.size}/${card.contour}/${card.decision}]`
}

function idList(ids: readonly number[]): string {
  return ids.length === 0 ? NONE : ids.map(id => `#${id}`).join(', ')
}

export function cardLine(card: Omit<Card, 'line'>): string {
  return `${cardHead(card)}${DEPENDS}${idList(card.depends)}${BLOCKS}${idList(card.blocks)}`
}

export function cardTerms(card: Card): string {
  return `${card.kind} · ${card.contour} · ${card.decision}`
}

export function parseCard(text: string): ParsedCard {
  const line = text.trim()
  const head = HEAD.exec(line)
  if (head === null)
    return refused(`'${line}' is not a card; a card is '${CARD_GRAMMAR}'`)
  const [, id, name, bracket, rest] = head as unknown as [string, string, string, string, string]
  if (!ID.test(id))
    return refused(`id '#${id}' is not a number`)
  if (!NAME.test(name))
    return refused(`name '${name}' must be a slug of a-z, 0-9 and '-'`)
  const fields = bracket.split('/')
  if (fields.length !== 5)
    return refused(`'[${bracket}]' must hold five fields: <kind>/<milestone>/<size>/<contour>/<decision>`)
  const [kind, milestone, size, contour, decision] = fields as [string, string, string, string, string]
  if (!oneOf(KINDS, kind))
    return refused(`kind '${kind}' is not one of ${KINDS.join(', ')}`)
  if (!oneOf(MILESTONES, milestone))
    return refused(`milestone '${milestone}' is not one of ${MILESTONES.join(', ')}`)
  if (!oneOf(SIZES, size))
    return refused(`size '${size}' is not one of ${SIZES.join(', ')}`)
  if (!oneOf(CONTOURS, contour))
    return refused(`contour '${contour}' is not one of ${CONTOURS.join(', ')}`)
  if (!oneOf(DECISIONS, decision))
    return refused(`decision '${decision}' is not one of ${DECISIONS.join(', ')}`)
  if (!DECISIONS_OF_KIND[kind].includes(decision))
    return refused(`kind ${kind} takes decision ${DECISIONS_OF_KIND[kind].join(' or ')}, not ${decision}`)
  if (!rest.startsWith(DEPENDS))
    return refused(`'· depends <#id …|—>' must follow '[${bracket}]'`)
  const blocksAt = rest.indexOf(BLOCKS, DEPENDS.length)
  if (blocksAt === -1)
    return refused(`'· blocks <#id …|—>' must follow the depends list`)
  const dependsText = rest.slice(DEPENDS.length, blocksAt)
  const blocksText = rest.slice(blocksAt + BLOCKS.length)
  const depends = readDepends(dependsText)
  if (depends === null)
    return refused(`depends '${dependsText}' must be '#<id>' entries or '—'`)
  const blocks = readBlocks(blocksText)
  if (blocks === null)
    return refused(`blocks '${blocksText}' must start with '#<id>' entries or '—'`)
  return { kind: 'card', card: { id: Number(id), name, kind, milestone, size, contour, decision, depends, blocks, line } }
}
