import type { InForceDecision } from './decisions.js'
import { readBodyCard } from '../../src/card/grammar.js'
import { RISK_LEVELS, riskOf } from '../../src/card/risk.js'
import { ownerPathsOf } from '../../src/commands/intake/check.js'
import { matchGlob } from '../shredder/glob.js'
import { readOwnerMergeKinds } from '../shredder/reader.js'

export const VERSION_BRANCH = /^changeset-release\//
export const RELEASE_KIND = 'release'
const KINDS_NO_SHARD_MERGES = ['security-invariants']
export const OWNER_PR_MERGED_BY_THE_BUS = 77
const OWNER_EVEN_UNDER_THE_DECISION = 'R1'

export type AuthorityRule
  = | 'version_pr'
    | 'security_invariants'
    | 'owner_by_risk'
    | 'reserved'
    | 'decision_unread'
    | 'owner_without_shard'
    | 'r1'

export type AllowedRule = 'auto' | 'owner_under_shard' | 'owner_by_decision'

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
  decisions: readonly InForceDecision[]
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

export function reservationOf(cardId: number, description: string): boolean {
  return new RegExp(`#${cardId} reserved(?!\\w)`).test(description)
}

function reserved(facts: MergeFacts): MergeVerdict | null {
  const kinds = readOwnerMergeKinds(facts.ownerMergesText)
  const releaseTitle = kinds.find(kind => kind.kind === RELEASE_KIND)?.title ?? null
  if (VERSION_BRANCH.test(facts.headRef) || (releaseTitle !== null && facts.title === releaseTitle))
    return denied('version_pr', `${facts.headRef} is a version pull request and stays the owner's`)
  for (const kind of kinds.filter(entry => KINDS_NO_SHARD_MERGES.includes(entry.kind))) {
    const file = facts.files.find(candidate => meetsAny(candidate, kind.globs))
    if (file !== undefined)
      return denied('security_invariants', `changes ${file} (${kind.kind}) and stays the owner's`)
  }
  for (const row of ownerPathsOf(facts.ownerMergesText).byRisk) {
    const file = facts.files.find(candidate => reachesRisk(candidate, row.level) && meetsAny(candidate, row.globs))
    if (file !== undefined)
      return denied('owner_by_risk', `changes ${file}, owner by risk ${row.level}, and stays the owner's`)
  }
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
  const ownerPath = ownerPathOf(facts)
  if (decision === 'auto' && ownerPath === undefined)
    return { kind: 'allowed', rule: 'auto', detail: `card #${facts.cardId} is auto and no file meets an owner path` }
  const why = ownerPath === undefined ? `card #${facts.cardId} is ${decision}` : `changes ${ownerPath}, an owner path`
  if (facts.shardActive)
    return { kind: 'allowed', rule: 'owner_under_shard', detail: `${why}; this run's shard is active` }
  if (!facts.decisions.some(entry => entry.decisionId === OWNER_PR_MERGED_BY_THE_BUS))
    return denied('owner_without_shard', `${why}, no shard of this run is active and D-${OWNER_PR_MERGED_BY_THE_BUS} is not in force`)
  const r1 = facts.files.find(file => riskOf(file).level === OWNER_EVEN_UNDER_THE_DECISION)
  if (r1 !== undefined)
    return denied('r1', `${why}; ${r1} is ${OWNER_EVEN_UNDER_THE_DECISION} and stays the owner's under D-${OWNER_PR_MERGED_BY_THE_BUS}`)
  return { kind: 'allowed', rule: 'owner_by_decision', detail: `${why}; under D-${OWNER_PR_MERGED_BY_THE_BUS} a pass and green CI merge it without a shard` }
}
