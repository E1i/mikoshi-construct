import type { DatabaseSync } from 'node:sqlite'
import type { Witness } from '../ports/witnesses.js'
import type { InForceDecision } from './decisions.js'
import { readBodyCard } from '../../src/card/grammar.js'
import { createdPaths } from '../../src/card/parking.js'
import { RISK_LEVELS, riskOf } from '../../src/card/risk.js'
import { judgedFieldWitnessesOf, witnessesOf } from '../../src/commands/intake/admit.js'
import { isChangeWitness, ownerPathsOf } from '../../src/commands/intake/check.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { CARD_ADMITTED, MERGE_DONE, PR_CLOSED, WITNESS_RECORDED } from '../core/events.js'
import { GENERATED_PATHS } from '../core/generated-files.js'
import { matchGlob } from './shredder/glob.js'
import { readOwnerMergeKinds } from './shredder/reader.js'

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
    | 'unsandboxed_command'
    | 'ratchet_grows'

export const OWNER_MERGES_RULES: ReadonlySet<AuthorityRule> = new Set(['version_pr', 'no_shard_merge', 'owner_merges_unread', 'owner_by_risk', 'reserved', 'owner_without_shard', 'r1', 'unsandboxed_command', 'ratchet_grows'])

export type AllowedRule = 'auto' | 'owner_under_shard' | 'owner_by_decision' | 'owner_after_round_limit'

export type MergeVerdict
  = | { kind: 'allowed', rule: AllowedRule, detail: string }
    | { kind: 'denied', rule: AuthorityRule, detail: string }

export interface PatchedFile {
  filename: string
  patch?: string
  additions?: number
}

export interface MergeFacts {
  cardId: number
  description: string
  headRef: string
  title: string
  files: readonly string[]
  patched: readonly PatchedFile[]
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

function changesOwnerMerges(facts: MergeFacts): MergeVerdict | null {
  return facts.files.includes(OWNER_MERGES)
    ? denied('no_shard_merge', `changes ${OWNER_MERGES}, which draws the owner's boundaries and stays the owner's under every shard whatever either table says`)
    : null
}

const RUNS_NOTHING = /^(?:scripts\/tests|tests|e2e)\/|\.md$/
const GENERATED_PATH_SET: ReadonlySet<string> = new Set(GENERATED_PATHS)
const HUNK_START = /^(?=@@ )/m
const EXCLUDED_COMMANDS = 'excludedCommands'
const EXCLUDED_ENTRY = 'excludedCommands entry'
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g
const ARRAY_PUNCTUATION_ONLY = /^[[\]\s,()]*$/
const UNSANDBOXED_LINE_FORMS: readonly { form: string, line: RegExp }[] = [
  { form: 'allowUnsandboxedCommands other than false', line: /allowUnsandboxedCommands(?!["']?\s*[:=]\s*false\b)/ },
  { form: 'dangerouslyDisableSandbox', line: /dangerouslyDisableSandbox/ },
  { form: 'an import of child_process', line: /child_process/ },
  { form: 'a spawn call', line: /(?<![\w$.])(?:execFileSync|execFile|execSync|exec|spawnSync|spawn|fork)\(/ },
]

type PatchSide = '-' | '+'

interface CommandCall {
  form: string
  text: string
}

function callKey(call: CommandCall): string {
  return `${call.form}\u0000${call.text}`
}

function bracketDepthChange(text: string): number {
  const bare = text.replace(STRING_LITERAL, '')
  return [...bare].reduce((depth, char) => depth + (char === '[' ? 1 : char === ']' ? -1 : 0), 0)
}

function entriesOf(segment: string): string[] {
  const literals = segment.match(STRING_LITERAL)
  if (literals !== null)
    return literals
  const bare = segment.trim().replace(/,$/, '')
  return ARRAY_PUNCTUATION_ONLY.test(bare) ? [] : [bare]
}

function callsOnSide(hunk: string, side: PatchSide): CommandCall[] {
  const calls: CommandCall[] = []
  let depth = 0
  let keyAwaitsArray = false
  for (const line of hunk.split('\n').slice(1)) {
    const mark = line[0]
    if (mark !== ' ' && mark !== side)
      continue
    const own = mark === side
    const text = line.slice(1)
    const trimmed = text.trim()
    if (own)
      calls.push(...UNSANDBOXED_LINE_FORMS.filter(({ line: form }) => form.test(text)).map(({ form }) => ({ form, text: trimmed })))
    let inside: string | undefined
    if (depth > 0) {
      inside = text
    }
    else {
      const key = text.indexOf(EXCLUDED_COMMANDS)
      if (key !== -1) {
        if (own)
          calls.push({ form: EXCLUDED_COMMANDS, text: trimmed })
        const rest = text.slice(key + EXCLUDED_COMMANDS.length)
        const open = rest.indexOf('[')
        keyAwaitsArray = open === -1 && /^["']?\??\s*(?:[:=]\s*)?$/.test(rest)
        inside = open === -1 ? undefined : rest.slice(open)
      }
      else if (keyAwaitsArray && trimmed.startsWith('[')) {
        keyAwaitsArray = false
        inside = trimmed
      }
      else if (trimmed !== '') {
        keyAwaitsArray = false
      }
    }
    if (inside === undefined)
      continue
    if (own)
      calls.push(...entriesOf(inside).map(entry => ({ form: EXCLUDED_ENTRY, text: entry })))
    depth = Math.max(0, depth + bracketDepthChange(inside))
  }
  return calls
}

function newCommandCallIn(patch: string): CommandCall | undefined {
  const hunks = patch.split(HUNK_START).filter(hunk => hunk.startsWith('@@'))
  const removed = new Map<string, number>()
  for (const call of hunks.flatMap(hunk => callsOnSide(hunk, '-')))
    removed.set(callKey(call), (removed.get(callKey(call)) ?? 0) + 1)
  for (const call of hunks.flatMap(hunk => callsOnSide(hunk, '+'))) {
    const held = removed.get(callKey(call)) ?? 0
    if (held === 0)
      return call
    removed.set(callKey(call), held - 1)
  }
  return undefined
}

function unsandboxedCommand(facts: MergeFacts): MergeVerdict | null {
  for (const { filename, patch, additions } of facts.patched) {
    if (RUNS_NOTHING.test(filename) || GENERATED_PATH_SET.has(filename))
      continue
    if (patch === undefined && additions !== 0)
      return denied('unsandboxed_command', `GitHub gives no patch for ${filename}, so whether it adds a command outside the sandbox is unknown, and it stays the owner's`)
    const call = patch === undefined ? undefined : newCommandCallIn(patch)
    if (call !== undefined)
      return denied('unsandboxed_command', `the diff of ${filename} adds ${call.form} (${call.text}) that its removed lines do not hold: a command outside the sandbox stays the owner's under every shard and every decision`)
  }
  return null
}

const RATCHET_RECORD = 'contract/ratchet.json'
const RATCHET_NUMBER = /^[+-]\s*"(?<key>[^"]+)":\s*(?<value>\d+),?\s*$/

function ratchetGrowthIn(patch: string): string | undefined {
  const lines = patch.split('\n')
  const lowered = new Map(lines.filter(line => line.startsWith('-')).flatMap((line) => {
    const groups = RATCHET_NUMBER.exec(line)?.groups
    return groups === undefined ? [] : [[groups.key!, Number(groups.value)] as const]
  }))
  for (const line of lines.filter(candidate => candidate.startsWith('+'))) {
    const groups = RATCHET_NUMBER.exec(line)?.groups
    if (groups === undefined)
      return `adds the line ${line}, which is not one key and one number`
    const held = lowered.get(groups.key!)
    if (held === undefined)
      return `adds ${groups.key}`
    if (Number(groups.value) > held)
      return `raises ${groups.key} from ${held} to ${groups.value}`
  }
  return undefined
}

function ratchetGrows(facts: MergeFacts): MergeVerdict | null {
  if (!facts.files.includes(RATCHET_RECORD))
    return null
  const patch = facts.patched.find(({ filename }) => filename === RATCHET_RECORD)?.patch
  if (patch === undefined)
    return denied('ratchet_grows', `GitHub gives no patch for ${RATCHET_RECORD}, so whether it grows is unknown, and it stays the owner's`)
  const growth = ratchetGrowthIn(patch)
  return growth === undefined ? null : denied('ratchet_grows', `the diff of ${RATCHET_RECORD} ${growth}: its growth stays the owner's under every shard and every decision`)
}

function reserved(facts: MergeFacts): MergeVerdict | null {
  const kinds = readOwnerMergeKinds(facts.ownerMergesText)
  const releaseTitle = kinds.find(kind => kind.kind === RELEASE_KIND)?.title ?? null
  if (VERSION_BRANCH.test(facts.headRef) || (releaseTitle !== null && facts.title === releaseTitle))
    return denied('version_pr', `${facts.headRef} is a version pull request and stays the owner's`)
  const ownersUnderEveryShard = reservedCardOf(facts) ?? changesOwnerMerges(facts) ?? noShardMerge(facts) ?? ratchetGrows(facts) ?? unsandboxedCommand(facts)
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

export const CLOSE_RULES = ['version_pr', 'not_open', 'no_card', 'other_card', 'merge_leased'] as const
export const RETRIED_CLOSE_RULES: ReadonlySet<CloseRule> = new Set(['merge_leased'])

export type CloseRule = typeof CLOSE_RULES[number]

export type CloseVerdict
  = | { kind: 'allowed', rule: 'card_pr', detail: string }
    | { kind: 'denied', rule: CloseRule, detail: string }

export interface CloseFacts {
  pr: number
  state: string
  headRef: string
  body: string
  cardId: number
  mergeLeased: boolean
}

export function closePolicy(facts: CloseFacts): CloseVerdict {
  if (VERSION_BRANCH.test(facts.headRef))
    return { kind: 'denied', rule: 'version_pr', detail: `PR #${facts.pr} on ${facts.headRef} is the version pull request and stays the owner's` }
  if (facts.state !== 'open')
    return { kind: 'denied', rule: 'not_open', detail: `PR #${facts.pr} is ${facts.state}, not open` }
  const card = readBodyCard(facts.body)
  if (card.kind === 'refused')
    return { kind: 'denied', rule: 'no_card', detail: `PR #${facts.pr} names no card on the first line of its description (${card.reason}) and stays the owner's` }
  if (card.card.id !== facts.cardId)
    return { kind: 'denied', rule: 'other_card', detail: `PR #${facts.pr} is the pull request of card #${card.card.id}, not #${facts.cardId}` }
  if (facts.mergeLeased)
    return { kind: 'denied', rule: 'merge_leased', detail: `PR #${facts.pr} is under a live merge lease` }
  return { kind: 'allowed', rule: 'card_pr', detail: `PR #${facts.pr} is the pull request of card #${card.card.id}, open and under no merge lease` }
}

export const REOPEN_RULES = ['version_pr', 'not_closed', 'merged', 'no_card', 'other_card', 'card_ended'] as const
export const ENDED_CARD_STATES: ReadonlySet<string> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])

export type ReopenRule = typeof REOPEN_RULES[number]

export type ReopenVerdict
  = | { kind: 'allowed', rule: 'card_pr', detail: string }
    | { kind: 'denied', rule: ReopenRule, detail: string }

export interface ReopenFacts {
  pr: number
  state: string
  merged: boolean
  headRef: string
  body: string
  cardId: number
  cardState: string | null
}

export function reopenPolicy(facts: ReopenFacts): ReopenVerdict {
  if (VERSION_BRANCH.test(facts.headRef))
    return { kind: 'denied', rule: 'version_pr', detail: `PR #${facts.pr} on ${facts.headRef} is the version pull request and stays the owner's` }
  if (facts.merged)
    return { kind: 'denied', rule: 'merged', detail: `PR #${facts.pr} is merged; a merged pull request is not reopened` }
  if (facts.state !== 'closed')
    return { kind: 'denied', rule: 'not_closed', detail: `PR #${facts.pr} is ${facts.state}, not closed` }
  const card = readBodyCard(facts.body)
  if (card.kind === 'refused')
    return { kind: 'denied', rule: 'no_card', detail: `PR #${facts.pr} names no card on the first line of its description (${card.reason}) and stays the owner's` }
  if (card.card.id !== facts.cardId)
    return { kind: 'denied', rule: 'other_card', detail: `PR #${facts.pr} is the pull request of card #${card.card.id}, not #${facts.cardId}` }
  if (facts.cardState !== null && ENDED_CARD_STATES.has(facts.cardState))
    return { kind: 'denied', rule: 'card_ended', detail: `card #${facts.cardId} is ${facts.cardState} in the bus, so nothing would close PR #${facts.pr} again` }
  return { kind: 'allowed', rule: 'card_pr', detail: `PR #${facts.pr} is the closed unmerged pull request of card #${facts.cardId}, which the bus holds live` }
}

export type CardPrRule = 'version_pr' | 'not_open' | 'no_card'

export type CardPrVerdict
  = | { kind: 'allowed', rule: 'card_pr', cardId: number, detail: string }
    | { kind: 'denied', rule: CardPrRule, detail: string }

export interface CardPrFacts {
  pr: number
  state: string
  headRef: string
  body: string
}

export function cardPrPolicy(facts: CardPrFacts): CardPrVerdict {
  if (VERSION_BRANCH.test(facts.headRef))
    return { kind: 'denied', rule: 'version_pr', detail: `PR #${facts.pr} on ${facts.headRef} is the version pull request and stays the owner's` }
  if (facts.state !== 'open')
    return { kind: 'denied', rule: 'not_open', detail: `PR #${facts.pr} is ${facts.state}, not open` }
  const card = readBodyCard(facts.body)
  if (card.kind === 'refused')
    return { kind: 'denied', rule: 'no_card', detail: `PR #${facts.pr} names no card on the first line of its description (${card.reason}) and stays the owner's` }
  return { kind: 'allowed', rule: 'card_pr', cardId: card.card.id, detail: `PR #${facts.pr} is the open pull request of card #${card.card.id}` }
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
export const UNCHECKED = 'unchecked'

const CREATES_LINE = /^creates:(.*)$/m
const BACKTICKED = /`([^`]+)`/g
const EXITS_ONE_ON_HEAD_ZERO_ON_BASE = /\bexits 1 on (?:the )?head,? and (?:exits )?0 on (?:the )?(?:base|main)\b/i
const NEGATION = /^!\s+/

export type WitnessVerdict = typeof GREEN | typeof RED | typeof UNCHECKED

const STORED_VERDICTS: ReadonlySet<unknown> = new Set([GREEN, RED, UNCHECKED])

function storedVerdict(stored: unknown): WitnessVerdict {
  return STORED_VERDICTS.has(stored) ? stored as WitnessVerdict : RED
}

export interface CardWitnesses {
  acceptance: Witness[]
  invariants: Witness[]
}

export interface WitnessSubject extends CardWitnesses {
  cardId: number
  cardBody: string
  creates: string[]
}

export function cardCreatesOf(body: string): string[] {
  return createdPaths((CREATES_LINE.exec(body)?.[1] ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== ''))
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

function failsOnHeadPassesOnBase(item: string): boolean {
  return EXITS_ONE_ON_HEAD_ZERO_ON_BASE.test(item.replace(BACKTICKED, ''))
}

function negated(commands: readonly string[]): string {
  const [only] = commands
  if (commands.length === 1 && NEGATION.test(only!))
    return only!.replace(NEGATION, '')
  return commands.length === 1 ? `! ${only!}` : `! { ${commands.join(' && ')}; }`
}

export function cardWitnessesOf(body: string): CardWitnesses {
  const judged = judgedFieldWitnessesOf(body)
  if (judged !== null)
    return judged
  const items = witnessesOf(body).filter(item => commandsOf(item).length > 0)
  const byExit = items.filter(failsOnHeadPassesOnBase)
  const rest = items.filter(item => !byExit.includes(item))
  return {
    acceptance: [
      ...rest.filter(isChangeWitness).map(item => ({ criterion: item, command: commandsOf(item).join(' && ') })),
      ...byExit.map(item => ({ criterion: item, command: negated(commandsOf(item)) })),
    ],
    invariants: rest.filter(item => !isChangeWitness(item)).flatMap(item => commandsOf(item).map(command => ({ criterion: item, command }))),
  }
}

const LATEST_ADMISSION_WITH_TEXT = `
  SELECT json_extract(payload, '$.bodySha') AS body_sha, json_extract(payload, '$.text') AS text FROM events
  WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ?
    AND json_type(payload, '$.bodySha') = 'text' AND json_type(payload, '$.text') = 'text'
  ORDER BY id DESC LIMIT 1
`

export function witnessSubjectOf(db: DatabaseSync, cardId: number): WitnessSubject | null {
  const admission = db.prepare(LATEST_ADMISSION_WITH_TEXT).get(cardId) as { body_sha: string, text: string } | undefined
  if (admission === undefined)
    return null
  const witnesses = cardWitnessesOf(admission.text)
  return witnesses.acceptance.length + witnesses.invariants.length === 0 ? null : { cardId, cardBody: admission.body_sha, creates: cardCreatesOf(admission.text), ...witnesses }
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
  return { verdict: storedVerdict(payload.verdict), base: String(payload.base ?? ''), detail: String(payload.detail ?? '') }
}

function recordDenial(db: DatabaseSync, subject: WitnessSubject, head: string, base: string | null): WitnessDenial | null {
  const record = witnessRecordOf(db, subject.cardId, head, base, subject.cardBody)
  const where = base === null ? '' : ` on the base ${base}`
  if (record === null)
    return { detail: `no ${WITNESS_RECORDED} for card #${subject.cardId} at head ${head}${where} under card body ${subject.cardBody}: the witness node has not run every card witness red on the base and green on this head`, base }
  if (record.verdict === UNCHECKED)
    return { detail: `the ${WITNESS_RECORDED} for card #${subject.cardId} at head ${head} on the base ${record.base} under card body ${subject.cardBody} could not check, so nothing passed: ${record.detail}`, base }
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
