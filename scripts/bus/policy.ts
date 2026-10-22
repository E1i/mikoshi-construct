import type { DatabaseSync } from 'node:sqlite'
import type { InForceDecision } from './decisions.js'
import type { Witness } from './witnesses.js'
import { readBodyCard } from '../../src/card/grammar.js'
import { RISK_LEVELS, riskOf } from '../../src/card/risk.js'
import { witnessesOf } from '../../src/commands/intake/admit.js'
import { ownerPathsOf } from '../../src/commands/intake/check.js'
import { MERGE_DONE, PR_CLOSED, WITNESS_RECORDED } from '../core/events.js'
import { matchGlob } from '../shredder/glob.js'
import { readOwnerMergeKinds } from '../shredder/reader.js'
import { cardBodyText } from './card-bodies.js'
import { cardBodyShaOfCard } from './queue.js'

export const OWNER_MERGES = 'architecture/owner-merges.md'
export const VERSION_BRANCH = /^changeset-release\//
export const RELEASE_KIND = 'release'
export const MERGES_UNDER_A_SHARD = 'merges under a shard'
const MERGES_UNDER_A_SHARD_VALUES: Readonly<Record<string, boolean>> = { yes: true, no: false }
const OWNER_KINDS_HEADER = '| kind |'
export const OWNER_PR_MERGED_BY_THE_BUS = 77
export const OWNER_EVEN_UNDER_THE_DECISION = 'R1'
export const MATRIX_COUNT_LINE = /■ \d+ □ \d+ · \d+/
const MATRIX_REQUIRED_UNDER = ['src/', 'templates/']

export type AuthorityRule
  = | 'version_pr'
    | 'no_shard_merge'
    | 'owner_merges_unread'
    | 'owner_by_risk'
    | 'reserved'
    | 'decision_unread'
    | 'owner_without_shard'
    | 'r1'
    | 'no_matrix_count_line'

export const OWNER_MERGES_RULES: ReadonlySet<AuthorityRule> = new Set(['version_pr', 'no_shard_merge', 'owner_merges_unread', 'owner_by_risk', 'reserved', 'owner_without_shard', 'r1'])

export type AllowedRule = 'auto' | 'owner_under_shard' | 'owner_by_decision' | 'owner_after_round_limit'

export type MergeVerdict
  = | { kind: 'allowed', rule: AllowedRule, detail: string }
    | { kind: 'denied', rule: AuthorityRule, detail: string }

export interface MergeFacts {
  cardId: number
  description: string
  headRef: string
  title: string
  files: readonly string[]
  ownerMergesText: string
  shardActive: boolean
  shardUnder: number | null
  windowShard: string | null
  decisions: readonly InForceDecision[]
}

function delegatedByShard(facts: MergeFacts): number | null {
  if (!facts.shardActive || facts.shardUnder === null)
    return null
  return facts.decisions.some(decision => decision.decisionId === facts.shardUnder) ? facts.shardUnder : null
}

function meetsAny(file: string, globs: readonly string[]): boolean {
  return globs.some(glob => matchGlob(glob, file))
}

function reachesRisk(file: string, level: string): boolean {
  const at = RISK_LEVELS.findIndex(candidate => candidate === level)
  return at !== -1 && RISK_LEVELS.indexOf(riskOf(file).level) <= at
}

function denied(rule: AuthorityRule, detail: string): MergeVerdict {
  return { kind: 'denied', rule, detail }
}

export function pathWithoutMatrix(body: string, files: readonly string[]): string | undefined {
  return MATRIX_COUNT_LINE.test(body) ? undefined : files.find(file => MATRIX_REQUIRED_UNDER.some(root => file.startsWith(root)))
}

export function reservationOf(cardId: number, description: string): boolean {
  return new RegExp(`#${cardId} reserved(?!\\w)`).test(description)
}

interface ShardMark {
  kind: string
  globs: string[]
  value: string
}

type ShardMarks = { kind: 'read', marks: ShardMark[] } | { kind: 'unread', reason: string }

function cellsOf(line: string): string[] {
  return line.split('|').slice(1, -1).map(cell => cell.trim())
}

function shardMarksOf(ownerMergesText: string): ShardMarks {
  const lines = ownerMergesText.split('\n').map(line => line.trim())
  const header = lines.findIndex(line => line.startsWith(OWNER_KINDS_HEADER))
  if (header === -1)
    return { kind: 'unread', reason: `${OWNER_MERGES} has no table of kinds` }
  const columns = cellsOf(lines[header]!)
  const column = columns.indexOf(MERGES_UNDER_A_SHARD)
  if (column === -1)
    return { kind: 'unread', reason: `the table of kinds in ${OWNER_MERGES} has no column «${MERGES_UNDER_A_SHARD}»` }
  const body = lines.slice(header + 2)
  const end = body.findIndex(line => !line.startsWith('|'))
  const rows = (end === -1 ? body : body.slice(0, end)).map(cellsOf)
  const ragged = rows.find(cells => cells.length !== columns.length)
  if (ragged !== undefined)
    return { kind: 'unread', reason: `the row ${ragged[0] ?? ''} of the table of kinds in ${OWNER_MERGES} has ${ragged.length} cells, its header ${columns.length}` }
  return { kind: 'read', marks: rows.map(cells => ({ kind: cells[0]!, globs: [...cells[1]!.matchAll(/`([^`]+)`/g)].map(match => match[1]!), value: cells[column]! })) }
}

function noShardMerge(facts: MergeFacts): MergeVerdict | null {
  const read = shardMarksOf(facts.ownerMergesText)
  if (read.kind === 'unread')
    return denied('owner_merges_unread', `${read.reason}; whether a kind merges under a shard is unknown, so the pull request stays the owner's`)
  for (const mark of read.marks) {
    const file = facts.files.find(candidate => meetsAny(candidate, mark.globs))
    if (file === undefined)
      continue
    const merges = MERGES_UNDER_A_SHARD_VALUES[mark.value]
    if (merges === undefined)
      return denied('owner_merges_unread', `changes ${file} (${mark.kind}), whose «${MERGES_UNDER_A_SHARD}» is «${mark.value}», neither yes nor no, so it stays the owner's`)
    if (!merges)
      return denied('no_shard_merge', `changes ${file} (${mark.kind}), which does not merge under a shard or a decision, and stays the owner's`)
  }
  return null
}

function reserved(facts: MergeFacts): MergeVerdict | null {
  const kinds = readOwnerMergeKinds(facts.ownerMergesText)
  const releaseTitle = kinds.find(kind => kind.kind === RELEASE_KIND)?.title ?? null
  if (VERSION_BRANCH.test(facts.headRef) || (releaseTitle !== null && facts.title === releaseTitle))
    return denied('version_pr', `${facts.headRef} is a version pull request and stays the owner's`)
  const ownersUnderEveryShard = reservedCardOf(facts) ?? noShardMerge(facts)
  if (ownersUnderEveryShard !== null || delegatedByShard(facts) !== null)
    return ownersUnderEveryShard
  if (facts.windowShard !== null)
    return null
  for (const row of ownerPathsOf(facts.ownerMergesText).byRisk) {
    const file = facts.files.find(candidate => reachesRisk(candidate, row.level) && meetsAny(candidate, row.globs))
    if (file !== undefined)
      return denied('owner_by_risk', `changes ${file}, owner by risk ${row.level}, and stays the owner's`)
  }
  return null
}

function reservedCardOf(facts: MergeFacts): MergeVerdict | null {
  if (reservationOf(facts.cardId, facts.description))
    return denied('reserved', `card #${facts.cardId} is reserved for the owner`)
  const reserving = facts.decisions.find(decision => reservationOf(facts.cardId, decision.text))
  if (reserving !== undefined)
    return denied('reserved', `D-${reserving.decisionId} reserves card #${facts.cardId} for the owner`)
  return null
}

function ownerPathOf(facts: MergeFacts): string | undefined {
  const globs = ownerPathsOf(facts.ownerMergesText).globs
  return facts.files.find(file => meetsAny(file, globs))
}

export function mergePolicy(facts: MergeFacts): MergeVerdict {
  const reservation = reserved(facts)
  if (reservation !== null)
    return reservation
  const card = readBodyCard(facts.description)
  if (card.kind === 'refused')
    return denied('decision_unread', `the first line of the description is not a card: ${card.reason}`)
  if (card.card.id !== facts.cardId)
    return denied('decision_unread', `the description names card #${card.card.id}, the task is for #${facts.cardId}`)
  const { decision } = card.card
  if (decision === 'none')
    return denied('decision_unread', `card #${facts.cardId} is ${decision}, neither auto nor owner`)
  const unmatrixed = pathWithoutMatrix(facts.description, facts.files)
  if (unmatrixed !== undefined)
    return denied('no_matrix_count_line', `changes ${unmatrixed} and its description has no code matrix count line ■ n □ n · n (architecture/code-matrix.md)`)
  const ownerPath = ownerPathOf(facts)
  if (decision === 'auto' && ownerPath === undefined)
    return { kind: 'allowed', rule: 'auto', detail: `card #${facts.cardId} is auto and no file meets an owner path` }
  const why = ownerPath === undefined ? `card #${facts.cardId} is ${decision}` : `changes ${ownerPath}, an owner path`
  const under = delegatedByShard(facts)
  if (under !== null)
    return { kind: 'allowed', rule: 'owner_under_shard', detail: `${why}; an unspent shard under D-${under}, in force, covers its card or pull request` }
  if (facts.shardActive)
    return { kind: 'allowed', rule: 'owner_under_shard', detail: `${why}; an unspent shard of its run, card or pull request covers it` }
  if (facts.windowShard !== null)
    return { kind: 'allowed', rule: 'owner_under_shard', detail: `${why}; the window shard ${facts.windowShard} covers it until its term` }
  if (!facts.decisions.some(entry => entry.decisionId === OWNER_PR_MERGED_BY_THE_BUS))
    return denied('owner_without_shard', `${why}, no unspent shard of its run, card or pull request covers it and D-${OWNER_PR_MERGED_BY_THE_BUS} is not in force`)
  const r1 = facts.files.find(file => riskOf(file).level === OWNER_EVEN_UNDER_THE_DECISION)
  if (r1 !== undefined)
    return denied('r1', `${why}; ${r1} is ${OWNER_EVEN_UNDER_THE_DECISION} and stays the owner's under D-${OWNER_PR_MERGED_BY_THE_BUS}`)
  return { kind: 'allowed', rule: 'owner_by_decision', detail: `${why}; under D-${OWNER_PR_MERGED_BY_THE_BUS} a pass and green CI merge it without a shard` }
}

export function pastRoundLimit(detail: string, decisionId: number, pr: number, head: string): MergeVerdict & { kind: 'allowed' } {
  return { kind: 'allowed', rule: 'owner_after_round_limit', detail: `${detail}; past the review round limit D-${decisionId} names PR #${pr} at ${head}` }
}

const YIELDS_TO_THE_OWNER_DECISION: ReadonlySet<AuthorityRule> = new Set(['owner_by_risk', 'owner_without_shard', 'r1'])

export function underOwnerDecision(verdict: MergeVerdict, decisionId: number, pr: number, head: string): MergeVerdict {
  if (verdict.kind === 'denied' && !YIELDS_TO_THE_OWNER_DECISION.has(verdict.rule))
    return verdict
  return pastRoundLimit(verdict.detail, decisionId, pr, head)
}

export const WITNESS_REASON = 'witness'
export const GREEN = 'green'
export const RED = 'red'

const RED_ON_THE_BASE = /\bred on (?:main|the base)\b/
const BACKTICKED = /`([^`]+)`/g

export type WitnessVerdict = typeof GREEN | typeof RED

export interface CardWitnesses {
  acceptance: Witness[]
  invariants: Witness[]
}

export interface WitnessSubject extends CardWitnesses {
  cardId: number
  cardBody: string
}

export interface WitnessRecord {
  verdict: WitnessVerdict
  base: string
  detail: string
}

const LATEST_RECORD = `
  SELECT payload FROM events
  WHERE type = '${WITNESS_RECORDED}' AND legacy = 0 AND card_id = ? AND head = ? AND json_extract(payload, '$.cardBody') = ?
    AND (? IS NULL OR json_extract(payload, '$.base') = ?)
  ORDER BY id DESC LIMIT 1
`

export const MERGE_RECORD = `
  SELECT payload FROM events
  WHERE pr = ? AND (type = '${MERGE_DONE}' OR (type = '${PR_CLOSED}' AND json_extract(payload, '$.merged') = 1))
  ORDER BY CASE type WHEN '${MERGE_DONE}' THEN 0 ELSE 1 END, id LIMIT 1
`

function commandsOf(item: string): string[] {
  return [...item.matchAll(BACKTICKED)].map(match => match[1]!.trim()).filter(command => command !== '')
}

export function cardWitnessesOf(body: string): CardWitnesses {
  const items = witnessesOf(body).filter(item => commandsOf(item).length > 0)
  return {
    acceptance: items.filter(item => RED_ON_THE_BASE.test(item)).map(item => ({ criterion: item, command: commandsOf(item).join(' && ') })),
    invariants: items.filter(item => !RED_ON_THE_BASE.test(item)).flatMap(item => commandsOf(item).map(command => ({ criterion: item, command }))),
  }
}

export function witnessSubjectOf(db: DatabaseSync, cardId: number): WitnessSubject | null {
  const cardBody = cardBodyShaOfCard(db, cardId)
  const text = cardBodyText(db, cardId)
  if (cardBody === null || text === null)
    return null
  const witnesses = cardWitnessesOf(text)
  return witnesses.acceptance.length + witnesses.invariants.length === 0 ? null : { cardId, cardBody, ...witnesses }
}

export interface WitnessDenial {
  detail: string
  base: string | null
}

export function witnessRecordOf(db: DatabaseSync, cardId: number, head: string, base: string | null, cardBody: string): WitnessRecord | null {
  const row = db.prepare(LATEST_RECORD).get(cardId, head, cardBody, base, base) as { payload: string } | undefined
  if (row === undefined)
    return null
  const payload = JSON.parse(row.payload) as { verdict?: unknown, base?: unknown, detail?: unknown }
  return { verdict: payload.verdict === GREEN ? GREEN : RED, base: String(payload.base ?? ''), detail: String(payload.detail ?? '') }
}

function recordDenial(db: DatabaseSync, subject: WitnessSubject, head: string, base: string | null): WitnessDenial | null {
  const record = witnessRecordOf(db, subject.cardId, head, base, subject.cardBody)
  const where = base === null ? '' : ` on the base ${base}`
  if (record === null)
    return { detail: `no ${WITNESS_RECORDED} for card #${subject.cardId} at head ${head}${where} under card body ${subject.cardBody}: the witness node has not run every card witness red on the base and green on this head`, base }
  if (record.verdict !== GREEN)
    return { detail: `the ${WITNESS_RECORDED} for card #${subject.cardId} at head ${head} on the base ${record.base} under card body ${subject.cardBody} is red: ${record.detail}`, base }
  return null
}

function noHeld(cardId: number, what: 'head' | 'base'): WitnessDenial {
  return { detail: `card #${cardId} declares witnesses and the task names no ${what} to hold a witness record for`, base: null }
}

export function witnessDenial(db: DatabaseSync, cardId: number, head: string | null, base: string | null): WitnessDenial | null {
  const subject = witnessSubjectOf(db, cardId)
  if (subject === null)
    return null
  if (head === null)
    return noHeld(cardId, 'head')
  if (base === null)
    return noHeld(cardId, 'base')
  return recordDenial(db, subject, head, base)
}

export function closeWitnessDenial(db: DatabaseSync, cardId: number, pr: number | null, head: string | null): WitnessDenial | null {
  const subject = witnessSubjectOf(db, cardId)
  if (subject === null)
    return null
  if (head === null)
    return noHeld(cardId, 'head')
  const merge = pr === null ? undefined : db.prepare(MERGE_RECORD).get(pr) as { payload: string } | undefined
  if (merge === undefined)
    return recordDenial(db, subject, head, null)
  const { witnessBase } = JSON.parse(merge.payload) as { witnessBase?: unknown }
  return typeof witnessBase === 'string' ? recordDenial(db, subject, head, witnessBase) : null
}
