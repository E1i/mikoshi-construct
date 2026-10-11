import type { Kind } from '../../card/grammar.js'
import type { DraftCard, UnclearField } from './draft.js'
import type { RepositoryFacts } from './facts.js'
import { CONTOURS, decisionsOf, KINDS } from '../../card/grammar.js'
import { createdPaths, parseCreatesEntry } from '../../card/parking.js'
import { RISK_LEVELS, riskOf } from '../../card/risk.js'
import { PREFIX_SUFFIX, touchError } from '../../card/task-file.js'
import { globToRegExp } from '../../model/glob.js'
import { commandWord } from './command-word.js'

export const DEFAULT_CONTOUR = 'ladder'
export const CARD_REFERENCE = /^#(\d+)$/
const BACKTICKED = /`([^`]+)`/g
const TEST_NAME_ARGUMENT = /(?:^|\s)(?:-t|--testNamePattern)(?:=|\s+)(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g
const FIELD_ORDER = ['number', 'contour', 'decision', 'touches', 'creates', 'depends', 'blocks']

const HARNESS_MEMBERSHIP_TEST = 'tests/harness-membership.test.ts'
const TESTS_ROOT = 'tests'
const SOURCE_MODULE = /^src\/(.+)\.ts$/

export const OWNER_MERGES = 'architecture/owner-merges.md'
const OWNER_KINDS_HEADER = '| kind |'
const OWNER_BY_RISK_HEADER = '| by risk |'
const OWNER_DECISION = 'owner'
const AUTO_DECISION = 'auto'
const OWNER_RISK = 'R1'
export const NO_OWNER_PATH = `no touch meets an owner path of ${OWNER_MERGES}`
const UNDER_PREFIX = 'x'

export interface CompanionRow {
  kind: string
  keptBy: string
  touched: (entry: string) => boolean
  companions: (entry: string, touches: readonly string[], repository: RepositoryFacts) => string[]
}

function scopeOf(entry: string): string {
  return entry.endsWith(PREFIX_SUFFIX) ? entry.slice(0, -PREFIX_SUFFIX.length) : entry
}

function under(entry: string, root: string): boolean {
  const scope = scopeOf(entry)
  return scope === root || scope.startsWith(`${root}/`)
}

function testBeside(entry: string, touches: readonly string[], repository: RepositoryFacts): string[] {
  if (touches.some(touch => under(touch, TESTS_ROOT)))
    return []
  const module = SOURCE_MODULE.exec(entry)?.[1]
  const mirrored = `${TESTS_ROOT}/${module}.test.ts`
  return [module !== undefined && repository.exists(mirrored) ? mirrored : `${TESTS_ROOT}${PREFIX_SUFFIX}`]
}

export const COMPANION_TABLE: readonly CompanionRow[] = [
  { kind: 'the scripts manifest', keptBy: HARNESS_MEMBERSHIP_TEST, touched: entry => entry === 'package.json', companions: () => ['CONTRIBUTING.md', HARNESS_MEMBERSHIP_TEST] },
  { kind: 'the command definitions', keptBy: 'tests/readme-commands.test.ts', touched: entry => entry === 'src/program.ts', companions: () => ['README.md', 'docs/cli.md', `docs/guide${PREFIX_SUFFIX}`] },
  { kind: 'published code', keptBy: '.changeset/config.json', touched: entry => under(entry, 'src') || under(entry, 'templates'), companions: () => [`.changeset${PREFIX_SUFFIX}`] },
  { kind: 'source code', keptBy: TESTS_ROOT, touched: entry => under(entry, 'src'), companions: testBeside },
]
export const COMPANION_REASON = 'every change of this kind carries it: the companion table in src/commands/intake/check.ts'

export interface Correction {
  field: string
  was: string
  now: string
  reason: string
}

export interface CheckedCard extends DraftCard {
  corrections: Correction[]
}

export interface CheckFacts {
  taken: ReadonlySet<number>
  parked: ReadonlySet<number>
  done: ReadonlySet<string>
  merged: ReadonlySet<string>
  repository: RepositoryFacts
  ownerMerges?: OwnerPaths
}

export interface OwnerByRisk {
  level: string
  globs: string[]
}

export interface OwnerPaths {
  globs: string[]
  byRisk: OwnerByRisk[]
}

function tableCells(text: string, headerStart: string): string[][] {
  const lines = text.split('\n').map(line => line.trim())
  const header = lines.findIndex(line => line.startsWith(headerStart))
  if (header === -1)
    return []
  const rows = lines.slice(header + 2)
  const end = rows.findIndex(line => !line.startsWith('|'))
  return (end === -1 ? rows : rows.slice(0, end)).map(row => row.split('|').slice(1, -1).map(cell => cell.trim()))
}

function globsIn(cell: string | undefined): string[] {
  return [...(cell ?? '').matchAll(BACKTICKED)].map(match => match[1]!)
}

export function ownerPathsOf(ownerMergesText: string): OwnerPaths {
  return {
    globs: tableCells(ownerMergesText, OWNER_KINDS_HEADER).flatMap(cells => globsIn(cells[1])),
    byRisk: tableCells(ownerMergesText, OWNER_BY_RISK_HEADER).map(cells => ({ level: cells[0] ?? '', globs: globsIn(cells[1]) })),
  }
}

function reachesLevel(touches: readonly string[], level: string): boolean {
  const at = RISK_LEVELS.findIndex(candidate => candidate === level)
  return at !== -1 && touches.some(touch => RISK_LEVELS.indexOf(riskOf(touch).level) <= at)
}

function meets(touch: string, glob: string): boolean {
  const pattern = globToRegExp(glob)
  if (!touch.endsWith(PREFIX_SUFFIX))
    return pattern.test(touch)
  const scope = scopeOf(touch)
  return glob.split('*')[0]!.startsWith(`${scope}/`) || pattern.test(`${scope}/${UNDER_PREFIX}`)
}

function heldBy(touches: readonly string[], globs: readonly string[]): { touch: string, glob: string } | undefined {
  for (const touch of touches) {
    const glob = globs.find(candidate => meets(touch, candidate))
    if (glob !== undefined)
      return { touch, glob }
  }
  return undefined
}

function ownerHold(touches: readonly string[], owner: OwnerPaths): { touch: string, glob: string, level?: string } | undefined {
  const byKind = heldBy(touches, owner.globs)
  if (byKind !== undefined)
    return byKind
  for (const row of owner.byRisk.filter(entry => reachesLevel(touches, entry.level))) {
    const byRisk = heldBy(touches, row.globs)
    if (byRisk !== undefined)
      return { ...byRisk, level: row.level }
  }
  return undefined
}

export function correctionText(correction: Correction): string {
  return `${correction.field} — ${correction.was} → ${correction.now} — ${correction.reason}`
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value)
}

function numberCorrection(card: DraftCard, assigned: number, facts: CheckFacts): Correction[] {
  const named = card.number
  if (named === undefined || named === assigned)
    return []
  const reason = facts.taken.has(named)
    ? `#${named} is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake`
    : facts.parked.has(named)
      ? `#${named} is taken by the parked card ${named}.md; numbers are assigned by construct intake`
      : 'numbers are assigned by construct intake, the next free after every number taken; a named number is never used'
  return [{ field: 'number', was: `#${named}`, now: `#${assigned}`, reason }]
}

function contourCorrection(card: DraftCard): Correction[] {
  if (card.contour === undefined || includes(CONTOURS, card.contour))
    return []
  return [{ field: 'contour', was: card.contour, now: DEFAULT_CONTOUR, reason: `'${card.contour}' is not one of ${CONTOURS.join(', ')}; ${DEFAULT_CONTOUR} is the path with a brief and witnesses` }]
}

function ownerReason(touches: readonly string[], owner: OwnerPaths): string | undefined {
  const hold = ownerHold(touches, owner)
  if (hold !== undefined)
    return `${hold.touch} meets ${hold.glob} of ${OWNER_MERGES}${hold.level === undefined ? '' : `, owner by risk ${hold.level}`}`
  const critical = touches.map(riskOf).find(reading => reading.level === OWNER_RISK)
  return critical === undefined ? undefined : `${critical.touch} is risk ${OWNER_RISK}, ${critical.why}`
}

function derivedDecision(decision: string, touches: readonly string[], owner: OwnerPaths): Correction[] {
  if (decision === OWNER_DECISION)
    return []
  const reason = ownerReason(touches, owner)
  if (reason === undefined)
    return decision === AUTO_DECISION ? [] : [{ field: 'decision', was: decision, now: AUTO_DECISION, reason: NO_OWNER_PATH }]
  return [{ field: 'decision', was: decision, now: OWNER_DECISION, reason }]
}

function unstatedDecision(card: DraftCard, touches: readonly string[], owner: OwnerPaths | undefined): string | undefined {
  if (card.decision !== undefined || owner === undefined || !includes(KINDS, card.kind) || !includes(decisionsOf(card.kind as Kind), OWNER_DECISION))
    return undefined
  return ownerReason(touches, owner) === undefined ? AUTO_DECISION : OWNER_DECISION
}

function decisionCorrection(card: DraftCard, touches: readonly string[], owner: OwnerPaths | undefined): Correction[] {
  if (card.decision === undefined || !includes(KINDS, card.kind))
    return []
  const decisions: readonly string[] = decisionsOf(card.kind as Kind)
  if (owner !== undefined && includes(decisions, OWNER_DECISION))
    return derivedDecision(card.decision, touches, owner)
  if (includes(decisions, card.decision))
    return []
  return [{ field: 'decision', was: card.decision, now: decisions[0]!, reason: `kind ${card.kind} takes decision ${decisions.join(' or ')}, not ${card.decision}` }]
}

export function refusesOwnerDecision(corrections: readonly Correction[]): boolean {
  return corrections.some(correction => correction.field === 'decision' && correction.was === OWNER_DECISION && correction.reason === NO_OWNER_PATH)
}

function candidatesText(candidates: readonly string[]): string {
  return candidates.length === 0 ? 'no path is' : `${candidates.length} paths: ${candidates.join(', ')} are`
}

interface Touched {
  touches: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

function touchesChecked(card: DraftCard, repository: RepositoryFacts): Touched {
  const touched: Touched = { touches: [], corrections: [], unclear: [] }
  const creates = createdPaths(card.creates)
  for (const parsed of card.creates.map(parseCreatesEntry)) {
    if (parsed.kind === 'refused')
      touched.unclear.push({ field: 'creates', reason: parsed.reason })
  }
  for (const entry of card.touches) {
    if (touchError(entry) !== null) {
      touched.touches.push(entry)
      continue
    }
    const created = creates.includes(entry)
    const prefix = entry.endsWith(PREFIX_SUFFIX) ? PREFIX_SUFFIX : ''
    const scope = prefix === '' ? entry : entry.slice(0, -PREFIX_SUFFIX.length)
    if (repository.exists(scope)) {
      touched.touches.push(entry)
      if (created)
        touched.corrections.push({ field: 'creates', was: entry, now: '(exists, not new)', reason: `${entry} already exists` })
      continue
    }
    const segment = scope.slice(scope.lastIndexOf('/') + 1)
    const candidates = created ? [] : repository.pathsNamed(segment)
    if (candidates.length === 1) {
      touched.touches.push(`${candidates[0]}${prefix}`)
      touched.corrections.push({ field: 'touches', was: entry, now: `${candidates[0]}${prefix}`, reason: `'${scope}' does not exist; '${candidates[0]}' is the only path named '${segment}'` })
      continue
    }
    touched.touches.push(entry)
    if (!created)
      touched.unclear.push({ field: 'touches', reason: `'${scope}' does not exist and ${candidatesText(candidates)} named '${segment}'; list it under creates if the change makes it` })
  }
  return touched
}

function covers(touch: string, companion: string): boolean {
  return touch === companion || (touch.endsWith(PREFIX_SUFFIX) && under(companion, scopeOf(touch)))
}

function withCompanions(touched: Touched, repository: RepositoryFacts): Touched {
  const missing: string[] = []
  for (const row of COMPANION_TABLE) {
    if (!repository.exists(row.keptBy))
      continue
    for (const entry of touched.touches.filter(row.touched)) {
      const touches = [...touched.touches, ...missing]
      for (const companion of row.companions(entry, touches, repository)) {
        if (repository.exists(scopeOf(companion)) && !touches.some(touch => covers(touch, companion)))
          missing.push(companion)
      }
    }
  }
  return {
    ...touched,
    touches: [...touched.touches, ...missing],
    corrections: [...touched.corrections, ...missing.map(companion => ({ field: 'touches', was: '(absent)', now: companion, reason: COMPANION_REASON }))],
  }
}

interface Linked {
  kept: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

function referencesChecked(field: 'depends' | 'blocks', references: readonly string[], facts: CheckFacts): Linked {
  const linked: Linked = { kept: [], corrections: [], unclear: [] }
  for (const reference of references) {
    const id = CARD_REFERENCE.exec(reference)?.[1]
    if (id === undefined) {
      linked.kept.push(reference)
    }
    else if (facts.merged.has(id)) {
      linked.corrections.push({ field, was: reference, now: '(removed)', reason: 'already merged' })
    }
    else {
      linked.kept.push(reference)
      if (!facts.parked.has(Number(id)) && !facts.done.has(id))
        linked.unclear.push({ field, reason: `'${reference}' is neither a parked card, done nor merged in the journal` })
    }
  }
  return linked
}

function witnessesUnclear(card: DraftCard, repository: RepositoryFacts): UnclearField[] {
  return card.witnesses.flatMap((witness) => {
    const words = [...witness.matchAll(BACKTICKED)].flatMap(match => commandWord(match[1]!) || [])
    if (words.length === 0)
      return [{ field: 'witnesses', reason: `'${witness.trim()}' names no command; a witness is run by a command` }]
    return [...new Set(words)]
      .filter(word => !repository.commandResolves(word))
      .map(word => ({ field: 'witnesses', reason: `'${word}' is not on PATH and is no file of the repository` }))
  })
}

function testNamePatterns(witness: string): string[] {
  return [...witness.matchAll(BACKTICKED)].flatMap(command => [...command[1]!.matchAll(TEST_NAME_ARGUMENT)].map(match => match[1] ?? match[2]?.replace(/\\([\\"$`])/g, '$1') ?? match[3]!))
}

export function invalidTestPatterns(cards: readonly DraftCard[]): string[] {
  return cards.flatMap(card => card.witnesses.flatMap(witness => testNamePatterns(witness).flatMap((pattern) => {
    try {
      return new RegExp(pattern, '') && []
    }
    catch (error) {
      return [`${witness.trim()} — ${error instanceof Error ? error.message : String(error)}`]
    }
  })))
}

function byFieldOrder(corrections: Correction[]): Correction[] {
  return [...corrections].sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))
}

function checkCard(card: DraftCard, assigned: number, facts: CheckFacts): CheckedCard {
  const touched = withCompanions(touchesChecked(card, facts.repository), facts.repository)
  const depends = referencesChecked('depends', card.depends, facts)
  const blocks = referencesChecked('blocks', card.blocks, facts)
  const contour = contourCorrection(card)
  const decision = decisionCorrection(card, touched.touches, facts.ownerMerges)
  return {
    ...card,
    contour: contour[0]?.now ?? card.contour,
    decision: decision[0]?.now ?? card.decision ?? unstatedDecision(card, touched.touches, facts.ownerMerges),
    touches: touched.touches,
    depends: depends.kept,
    blocks: blocks.kept,
    unclear: [
      ...card.unclear,
      ...touched.unclear,
      ...depends.unclear,
      ...blocks.unclear,
      ...witnessesUnclear(card, facts.repository),
    ],
    corrections: byFieldOrder([
      ...numberCorrection(card, assigned, facts),
      ...contour,
      ...decision,
      ...touched.corrections,
      ...depends.corrections,
      ...blocks.corrections,
    ]),
  }
}

export function checkDraft(cards: readonly DraftCard[], numbers: readonly number[], facts: CheckFacts): CheckedCard[] {
  return cards.map((card, index) => checkCard(card, numbers[index]!, facts))
}
