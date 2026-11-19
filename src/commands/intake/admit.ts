import type { DecisionsPort, OwnerWords } from '../../../scripts/policy/decisions/decisions.js'
import type { BusCardStates } from '../../card/closed.js'
import type { Card, Decision } from '../../card/grammar.js'
import type { ParkedTask } from '../../card/parking.js'
import type { WitnessExpectation, WitnessField } from '../../card/witness-fields.js'
import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { CardScope } from '../test-runner.js'
import type { CheckedCard } from './check.js'
import type { Confirmation } from './confirm.js'
import type { DraftCard } from './draft.js'
import type { CardAdmissionsPort, CardEventPort, CardStatesPort, RecordedIntake } from './index.js'
import type { SlicedCard } from './slice.js'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { CARD_ADMITTED } from '../../../scripts/core/events.js'
import { decisionCommand, InMemoryDecisions } from '../../../scripts/policy/decisions/decisions.js'
import { createdPaths, OWNER_MERGES, pathsIn, pathsOutside } from '../../../scripts/policy/touch-scope.js'
import { endedCards } from '../../card/closed.js'
import { cardLine, parseCard } from '../../card/grammar.js'
import { parseParkingFile } from '../../card/parking.js'
import { priorityLineOf, withKeptPriority } from '../../card/text-sha.js'
import { isWitnessFieldLine, renderedWitness, runsFieldLine, runsFieldOf, witnessesOf, witnessFieldsOf, witnessText } from '../../card/witness-fields.js'
import { readMilestones } from '../../manifest.js'
import { findsNoTest, namedAbsentOutside, namedPaths, withinScope } from '../test-runner.js'
import { CARD_REFERENCE, checkDraft, correctionText, FACTORY_TWIN, invalidTestPatterns, isChangeWitness, nonPathTouchRefusals, ownerPathsOf, PACKAGE_MANIFEST, publishedRootsOf } from './check.js'
import { TEST_NAME_ARGUMENT } from './command-word.js'
import { admitCorrectionsNeedPerson, bodySha, bodyShaWithoutTouches, confirmationOf, confirmationToken, isConfirmation, sameHeader, tokenConfirmation, TOUCHES_HEADER, windowShard } from './confirm.js'
import { withoutWitnessKind } from './draft.js'
import { DirectoryFacts } from './facts.js'
import { admittedRecord, defaultParking, downgradeEvent, heldEvent, INTAKE_EXIT, knownCards, openCardTextsBeside, recordIntake, waitingEvent, windowEvent } from './index.js'
import { parkedNumbers } from './numbers.js'
import { isWithin, parkingTree } from './parking-tree.js'
import { defaultContourMap, readContourMap, sharedCodeMaskRefusals } from './shared-code-masks.js'
import { CORRECTED_PREFIX, UNCLEAR_PREFIX, WITNESSES_HEADING } from './slice.js'

export { parentsFromCardLines } from './slice.js'

const BLOCKS_SEPARATOR = ' · blocks '
const LEADING_BLOCKS = /^(?:—|#\d+(?:,? #\d+)*)/
export const CARD_HEADER = 'card: '
const RUNS_HEADER = 'runs: ['
export const ADMIT_SOURCE = 'admit'
const LANE_NAME = /^(?:(?:lane|night)(?:-[\w.-]+)?|\d{4}-\d{2}-\d{2}-[a-z]+)$/

export function isLaneName(name: string): boolean {
  return LANE_NAME.test(name)
}

export function pathsNamedOutside(parked: ParkedTask, text: string): string[] {
  return pathsOutside(parked.task.touches, parked.creates, pathsIn(text)).filter(named => named !== FACTORY_TWIN)
}

export function laneOf(root: string, dir: string): string | null {
  const name = path.basename(dir)
  return path.dirname(path.resolve(dir)) === path.resolve(root) && isLaneName(name) ? name : null
}

export const LANE_FILE = 'lane.json'
export const AMEND_SOURCE = 'amend'

type AdmitSource = typeof ADMIT_SOURCE | typeof AMEND_SOURCE

export interface AdmitOptions {
  file: string
  body?: string
  dir: string
  dryRun: boolean
  confirm?: string
  autoConfirm: boolean
  parkingRoot?: string
  contourMap?: string
  events?: CardEventPort
  cardStates?: CardStatesPort
  admissions?: CardAdmissionsPort
  decisions?: DecisionsPort
  cardWaits?: CardWaitsPort
  writeRuns?: boolean
  priorityEdited?: boolean
}

export interface CardWait {
  card: number
  why: string
}

export type CardWaitsPort = (cardId: number) => CardWait[]

type RefusedWithReasons = 'invalidTestPattern' | 'sharedCodeMask'

const REFUSED_WITH_REASONS: Record<RefusedWithReasons, (lore: Lore) => string> = {
  invalidTestPattern: lore => lore.intakeRefusedInvalidTestPattern,
  sharedCodeMask: lore => lore.intakeRefusedSharedCodeMask,
}

export type AdmitResult
  = | { status: 'refused', why: string }
    | { status: 'invalidTestPattern', reasons: string[] }
    | { status: 'sharedCodeMask', reasons: string[] }
    | { status: 'admitted' | 'alreadyAdmitted' | 'dryRun', file: string, card: SlicedCard, autoConfirm: boolean, source: AdmitSource, inBus: boolean, event: number | null, windowShard: string | null }
    | { status: 'awaiting', file: string, card: SlicedCard, token: string, stale: boolean }
    | { status: 'waiting', file: string, card: SlicedCard, waitingOn: number[], inBus: boolean, dryRun: boolean }
    | { status: 'ownerWait', file: string, card: SlicedCard, downgrades: string[], actions: string[], command: string, inBus: boolean, dryRun: boolean }

const ANY_FORM_OF_FAILING_ON_MAIN = /(?:\s*[;,—–-])?\s*(?:red|non-zero) on main/i
const DOWNGRADE_ALLOWANCE = 'разрешить понижение свидетеля'
const GENERAL_DOWNGRADE_ALLOWANCE = 'разрешить понижение свидетелей у '
const LISTED_DOWNGRADE_ALLOWANCE = 'разрешить понижение свидетелей'
const DOWNGRADE_WORD = 'понижение'
export const EQUIVALENT_REPLACEMENT_ALLOWANCE = 'разрешить равноценную замену свидетеля:'
const CARD_SEPARATOR = /,\s*|\s+и\s+/
const ALLOWED_CARDS = new RegExp(`^#[1-9]\\d*(?:(?:${CARD_SEPARATOR.source})#[1-9]\\d*)*`)
export const DROPPED_CARD = 'dropped'
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g
const NO_DECISIONS = new InMemoryDecisions([])

function allowanceById(cardId: number, witnessId: string): string {
  return `${DOWNGRADE_ALLOWANCE} #${cardId} ${witnessId}`
}

function witnessIdIn(admitted: readonly string[], witness: string): string {
  return renderedWitness(witness)?.id ?? `W${admitted.indexOf(witness) + 1}`
}

export function downgradeAction(cardId: number, witness: string, admitted: readonly string[]): string {
  return allowanceById(cardId, witnessIdIn(admitted, witness))
}

export function downgradeCommand(cardId: number, witnesses: readonly string[], admitted: readonly string[]): string {
  const ids = witnesses.map(witness => witnessIdIn(admitted, witness))
  const phrase = ids.length === 1 ? allowanceById(cardId, ids[0]!) : `${LISTED_DOWNGRADE_ALLOWANCE} #${cardId} ${ids.join(' ')}`
  return decisionCommand(phrase, [cardId])
}

function witnessCore(witness: string): string {
  return withoutWitnessKind(witness).replace(ANY_FORM_OF_FAILING_ON_MAIN, '').trim()
}

type Outcome = WitnessExpectation | 'any'

interface WitnessFact { command: string, head: Outcome, base: Outcome, fromField?: boolean }

const BACKTICKED_COMMAND = /`([^`]+)`/g
const NEGATED_COMMAND = /^!\s+/
const FAILS_ON_HEAD = /\bexits 1\b(?! on (?:the )?(?:base|main)\b)|\b(?:fails|red) on (?:the )?head\b/i
const PASSES_ON_BASE = /\b(?:exits )?0 on (?:the )?(?:base|main)\b/i

function inverted(outcome: Outcome): Outcome {
  return outcome === 'pass' ? 'fail' : outcome === 'fail' ? 'pass' : outcome
}

function fieldFact(witness: string): WitnessFact | null {
  const field = renderedWitness(witness)
  if (field === null)
    return null
  const command = field.command.replace(NEGATED_COMMAND, '')
  return command === field.command
    ? { command, head: field.head, base: field.base, fromField: true }
    : { command, head: inverted(field.head), base: inverted(field.base), fromField: true }
}

function witnessFact(witness: string): WitnessFact | null {
  const field = fieldFact(witness)
  if (field !== null)
    return field
  const commands = [...witness.matchAll(BACKTICKED_COMMAND)].map(match => match[1]!.trim())
  if (commands.length !== 1)
    return null
  const wording = witness.replace(BACKTICKED_COMMAND, '')
  const head: Outcome = FAILS_ON_HEAD.test(wording) ? 'fail' : 'pass'
  const base: Outcome = isChangeWitness(witness) ? 'fail' : PASSES_ON_BASE.test(wording) ? 'pass' : 'any'
  const command = commands[0]!.replace(NEGATED_COMMAND, '')
  return command === commands[0] ? { command, head, base } : { command, head: inverted(head), base: inverted(base) }
}

function sameFact(left: WitnessFact, right: WitnessFact): boolean {
  return left.command === right.command && left.head === right.head && left.base === right.base
}

const VITEST_RUN = /\bvitest\b/
const TEST_FILE = /\S+\.(?:test|spec)\.[cm]?[jt]sx?(?=\s|$)/g
const MOVED_TEST_FILE = '<test file>'
const ESCAPED_CHARACTER = /\\(.)/g

function testNameOf(command: string): string | null {
  const names = [...command.matchAll(TEST_NAME_ARGUMENT)].map(match => match[1] ?? match[2] ?? match[3]!)
  return VITEST_RUN.test(command) && names.length === 1 ? names[0]! : null
}

function sameTestMoved(left: string, right: string): boolean {
  const name = testNameOf(left)
  return name !== null && name === testNameOf(right) && left.replace(TEST_FILE, MOVED_TEST_FILE) === right.replace(TEST_FILE, MOVED_TEST_FILE)
}

function equivalentReplacement(original: WitnessFact, replacement: WitnessFact): boolean {
  return original.head === replacement.head && original.base === replacement.base
    && (original.command === replacement.command || sameTestMoved(original.command, replacement.command))
}

function testNamesOf(command: string): string[] {
  return [...command.matchAll(TEST_NAME_ARGUMENT)].map(match => match[1] ?? match[2] ?? match[3]!)
}

function filterMatches(filter: string, name: string): boolean {
  try {
    return new RegExp(filter).test(name)
  }
  catch {
    return false
  }
}

function narrowsTheFilter(original: string, replacement: string): boolean {
  const name = testNameOf(replacement)
  if (name === null || original.replace(TEST_NAME_ARGUMENT, '') !== replacement.replace(TEST_NAME_ARGUMENT, ''))
    return false
  const filters = testNamesOf(original)
  return filters.length === 0 || (filters.length === 1 && filterMatches(filters[0]!, name.replace(ESCAPED_CHARACTER, '$1')))
}

function equivalentFieldReplacement(original: WitnessFact, replacement: WitnessFact): boolean {
  if (original.fromField !== true || replacement.fromField !== true || original.head !== replacement.head)
    return false
  const baseKept = original.base === replacement.base || (original.base === 'pass' && replacement.base === 'fail')
  return baseKept && (original.command === replacement.command || sameTestMoved(original.command, replacement.command) || narrowsTheFilter(original.command, replacement.command))
}

type Equivalence = (original: WitnessFact, replacement: WitnessFact) => boolean

function withoutReplaced(downgrades: readonly string[], previous: readonly string[], next: readonly string[], equivalent: Equivalence): string[] {
  const previousCores = new Set(previous.map(witnessCore))
  const replacements = next.filter(witness => !previousCores.has(witnessCore(witness))).flatMap(witness => witnessFact(witness) ?? [])
  return downgrades.filter((witness) => {
    const fact = witnessFact(witness)
    return fact === null || !replacements.some(replacement => equivalent(fact, replacement))
  })
}

export function unreplacedDowngrades(downgrades: readonly string[], previous: readonly string[], next: readonly string[]): string[] {
  return withoutReplaced(downgrades, previous, next, equivalentReplacement)
}

export function unreplacedFieldDowngrades(downgrades: readonly string[], previous: readonly string[], next: readonly string[]): string[] {
  return withoutReplaced(downgrades, previous, next, equivalentFieldReplacement)
}

export function witnessDowngrades(previous: readonly string[], next: readonly string[]): string[] {
  const acceptanceByCore = new Map(next.map(witness => [witnessCore(witness), isChangeWitness(witness)]))
  const nextFacts = next.flatMap(witness => witnessFact(witness) ?? [])
  return previous.filter((witness) => {
    const acceptance = acceptanceByCore.get(witnessCore(witness))
    if (acceptance !== undefined && !(isChangeWitness(witness) && !acceptance))
      return false
    const fact = witnessFact(witness)
    return fact === null || !nextFacts.some(other => sameFact(fact, other))
  })
}

function draftOf(parked: ParkedTask): DraftCard {
  const { card, touches, body } = parked.task
  return {
    name: card.name,
    kind: card.kind,
    milestone: card.milestone,
    size: card.size,
    contour: card.contour,
    decision: card.decision,
    touches,
    depends: card.depends.map(id => `#${id}`),
    blocks: card.blocks.map(id => `#${id}`),
    creates: parked.creates,
    task: body,
    witnesses: witnessesOf(body),
    runs: runsFieldOf(body),
    unclear: [],
  }
}

function ids(references: readonly string[]): number[] {
  return references.map(reference => Number(CARD_REFERENCE.exec(reference)![1]))
}

function unmergedKnown(references: readonly string[], parked: ReadonlySet<number>, cards: BusCardStates | undefined, done: ReadonlySet<string>): number[] {
  return references.flatMap((reference) => {
    const id = CARD_REFERENCE.exec(reference)?.[1]
    const known = id !== undefined && (parked.has(Number(id)) || done.has(id) || cards?.has(id) === true)
    return known ? [Number(id)] : []
  })
}

function droppedDepends(references: readonly string[], cards: BusCardStates | undefined): number[] {
  return references.flatMap((reference) => {
    const id = CARD_REFERENCE.exec(reference)?.[1]
    return id !== undefined && cards?.get(id) === DROPPED_CARD ? [Number(id)] : []
  })
}

function dependsOnDropped(cardId: number, dropped: readonly number[]): string {
  const named = dropped.map(id => `#${id}`).join(', ')
  return `#${cardId} depends on ${named}, dropped in the bus and never merging, so it would wait for ever; take ${named} out of its depends`
}

interface WaitStep extends CardWait {
  from: number
}

const DEPENDS_WHY = 'depends on '

function waitsBackOn(cardId: number, start: number, cardWaits: CardWaitsPort): WaitStep[] | null {
  const seen = new Set<number>()
  const walk = (from: number): WaitStep[] | null => {
    if (seen.has(from))
      return null
    seen.add(from)
    for (const wait of cardWaits(from)) {
      const step = { from, ...wait }
      const rest = wait.card === cardId ? [] : walk(wait.card)
      if (rest !== null)
        return [step, ...rest]
    }
    return null
  }
  return walk(start)
}

function stepText(step: WaitStep): string {
  return step.why.startsWith(DEPENDS_WHY) ? `#${step.from} ${step.why}` : `#${step.from} waits on #${step.card} (${step.why})`
}

function waitCycleText(cardId: number, depended: number, chain: readonly WaitStep[]): string {
  const none = chain.length === 1 ? 'neither ever moves' : 'none of them ever moves'
  return `#${cardId} depends on #${depended}, and ${chain.map(stepText).join(', ')}, so ${none}; drop the depends or settle #${cardId} first`
}

function newlyBound(depends: readonly number[], recorded: RecordedIntake | null): number[] {
  const parsed = recorded === null ? null : parseCard(recorded.card)
  const bound = new Set(parsed?.kind === 'card' ? parsed.card.depends : [])
  return depends.filter(id => !bound.has(id))
}

function waitCycle(cardId: number, depends: readonly number[], cardWaits: CardWaitsPort | undefined): string | null {
  if (cardWaits === undefined)
    return null
  for (const depended of depends) {
    const chain = waitsBackOn(cardId, depended, cardWaits)
    if (chain !== null)
      return waitCycleText(cardId, depended, chain)
  }
  return null
}

function writtenByTheOwner(decisions: DecisionsPort): OwnerWords[] {
  return decisions.inForce().filter(decision => decision.written)
}

export function ownerAllowed(decisions: DecisionsPort, cardId: number, downgrades: readonly string[], admitted: readonly string[]): boolean {
  const allowing = writtenByTheOwner(decisions).filter(decision => decision.cards.includes(cardId)).map(decision => decision.words)
  return downgrades.every(witness => allowing.some(words => namesTheWitness(words, witness, cardId, admitted) || phraseNamesCard(words, GENERAL_DOWNGRADE_ALLOWANCE, cardId)))
}

function namesTheWitness(line: string, witness: string, cardId: number, admitted: readonly string[]): boolean {
  const proseNamed = renderedWitness(witness) === null && phraseNamesCard(line, `${DOWNGRADE_ALLOWANCE} ${witness} у `, cardId)
  return proseNamed || namesTheId(line, cardId, witnessIdIn(admitted, witness))
}

function namesTheId(words: string, cardId: number, witnessId: string): boolean {
  const card = new RegExp(`(?<![\\w#])#${cardId}(?!\\d)`, 'u')
  const witness = new RegExp(`(?<!\\w)${witnessId.replace(REGEX_SPECIAL, '\\$&')}(?!\\w)`, 'u')
  return words.toLowerCase().includes(DOWNGRADE_WORD) && card.test(words) && witness.test(words)
}

const MOVE_JOINER = '\\s*(?:→|->|=>)\\s*|\\s+(?:to|в|на)\\s+'

function namesTheMove(words: string, from: string, to: string): boolean {
  return new RegExp(`(?<![\\p{L}\\d])${from}(?:${MOVE_JOINER})${to}(?![\\p{L}\\d])`, 'iu').test(words)
}

function withoutOwnerMoves(decisions: DecisionsPort, cardId: number, downgrades: readonly string[], previous: readonly string[], next: readonly string[]): string[] {
  const previousIds = new Set(previous.map(witness => witnessIdIn(previous, witness)))
  const added = next.map(witness => witnessIdIn(next, witness)).filter(id => !previousIds.has(id))
  const words = writtenByTheOwner(decisions).filter(decision => decision.cards.includes(cardId)).map(decision => decision.words)
  return downgrades.filter(witness => !added.some(to => words.some(each => namesTheMove(each, witnessIdIn(previous, witness), to))))
}

export const WITNESS_TRANSFER_IS_NO_DOWNGRADE = 'перенос свидетеля в другую карту'

export function witnessTransferIsNoDowngrade(decisions: DecisionsPort): boolean {
  return writtenByTheOwner(decisions)
    .some(decision => decision.cards.length === 0 && decision.words.toLowerCase().includes(WITNESS_TRANSFER_IS_NO_DOWNGRADE))
}

export function untransferred(downgrades: readonly string[], previousText: string, held: readonly Pick<WitnessField, 'run' | 'test'>[]): string[] {
  const fields = witnessFieldsOf(previousText) ?? []
  return downgrades.filter((witness) => {
    const field = fields.find(each => witnessText(each) === witness)
    return field === undefined || !held.some(other => other.run === field.run && other.test === field.test)
  })
}

function standingReplacementAllowed(decisions: DecisionsPort, cardId: number): boolean {
  return writtenByTheOwner(decisions)
    .some(decision => (decision.cards.length === 0 || decision.cards.includes(cardId)) && decision.words.startsWith(EQUIVALENT_REPLACEMENT_ALLOWANCE))
}

export const CREATED_PATHS_ARE_THE_CHANGE = 'a witness that checks paths the card itself creates is a witness of the change'

export function createdPathsAreTheChange(decisions: DecisionsPort): boolean {
  return writtenByTheOwner(decisions)
    .some(decision => decision.cards.length === 0 && decision.words.toLowerCase().includes(CREATED_PATHS_ARE_THE_CHANGE))
}

export interface BaseScope {
  dir: string
  card: CardScope
  createdAreTheChange: boolean
}

function absentFrom(scope: BaseScope, file: string): boolean {
  return !existsSync(path.join(scope.dir, file))
}

export function unfitOnTheBase(command: string, scope: BaseScope): boolean {
  const absent = (file: string): boolean => absentFrom(scope, file)
  return findsNoTest(command, absent) || namedAbsentOutside(command, scope.card, absent).length > 0
}

function checksOnlyCreatedPaths(command: string, scope: BaseScope): boolean {
  const named = namedPaths(command)
  return named.length > 0 && named.every(file => absentFrom(scope, file) && withinScope(file, [...scope.card.touches, ...scope.card.creates]))
}

function refinable(fact: WitnessFact, scope: BaseScope): boolean {
  return unfitOnTheBase(fact.command, scope) || (scope.createdAreTheChange && checksOnlyCreatedPaths(fact.command, scope))
}

function redOnMain(fact: WitnessFact, scope: BaseScope): boolean {
  return fact.head === 'pass' && fact.base === 'fail' && !unfitOnTheBase(fact.command, scope)
}

export function withoutRefinements(downgrades: readonly string[], previous: readonly string[], next: readonly string[], scope: BaseScope): string[] {
  const previousCores = new Set(previous.map(witnessCore))
  const strictIds = new Set(next
    .filter(witness => !previousCores.has(witnessCore(witness)))
    .filter((witness) => {
      const fact = witnessFact(witness)
      return fact !== null && redOnMain(fact, scope)
    })
    .map(witness => witnessIdIn(next, witness)))
  return downgrades.filter((witness) => {
    const fact = witnessFact(witness)
    return fact === null || !strictIds.has(witnessIdIn(previous, witness)) || !refinable(fact, scope)
  })
}

function phraseNamesCard(line: string, phrase: string, cardId: number): boolean {
  return line.split(phrase).slice(1).some(rest => ALLOWED_CARDS.exec(rest)?.[0].split(CARD_SEPARATOR).includes(`#${cardId}`) ?? false)
}

export function withRunsLine(text: string, runs: readonly string[]): string {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.startsWith(RUNS_HEADER))
  if (runs.length === 0)
    return at === -1 ? text : lines.filter((_, index) => index !== at).join('\n')
  if (at !== -1)
    return lines.map((line, index) => (index === at ? runsFieldLine(runs) : line)).join('\n')
  const before = lines.findIndex(line => isWitnessFieldLine(line) || line.trim() === WITNESSES_HEADING)
  return before === -1 ? text : [...lines.slice(0, before), runsFieldLine(runs), ...lines.slice(before)].join('\n')
}

export function blocksTail(line: string): string {
  const blocks = line.split(BLOCKS_SEPARATOR)[1] ?? ''
  return blocks.replace(LEADING_BLOCKS, '')
}

function admittedLine(card: Card, checked: CheckedCard): string {
  const depends = ids(checked.depends)
  const blocks = ids(checked.blocks)
  const decision = checked.decision as Decision
  if (depends.length === card.depends.length && blocks.length === card.blocks.length && decision === card.decision)
    return card.line
  return `${cardLine({ ...card, decision, depends, blocks })}${blocksTail(card.line)}`
}

function admittedText(text: string, line: string, checked: CheckedCard): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  const headerEnd = lines.findIndex(entry => entry.trim() === '')
  const rewritten = lines.map((entry, index) => {
    if (index >= headerEnd)
      return entry
    if (entry.startsWith(CARD_HEADER))
      return `${CARD_HEADER}${line}`
    if (entry.startsWith(TOUCHES_HEADER))
      return `${TOUCHES_HEADER}${checked.touches.join(', ')}`
    return entry
  })
  const notes = [
    ...checked.unclear.map(entry => `${UNCLEAR_PREFIX}${entry.field} — ${entry.reason}`),
    ...checked.corrections.map(correction => `${CORRECTED_PREFIX}${correctionText(correction)}`),
  ].filter(note => !lines.includes(note))
  return [...rewritten, ...(notes.length === 0 ? [] : ['', ...notes]), ''].join('\n')
}

function sameCardLine(recorded: string, line: string): boolean {
  const parsed = parseCard(line)
  const wanted = parsed.kind === 'card' ? cardLine(parsed.card) : line
  const recordedCard = parseCard(recorded)
  return recordedCard.kind === 'card' && cardLine(recordedCard.card) === wanted
}

function recordedConfirmation(recorded: RecordedIntake, card: SlicedCard, autoConfirm: boolean): Confirmation {
  const { confirmation } = recorded
  return isConfirmation(confirmation) ? confirmation : confirmationOf(card, autoConfirm)
}

function recordedSource(recorded: RecordedIntake): string | undefined {
  return typeof recorded.source === 'string' ? recorded.source : undefined
}

function admittedAt(recorded: RecordedIntake, now: () => Date): Date {
  return typeof recorded.ts === 'string' && !Number.isNaN(Date.parse(recorded.ts)) ? new Date(recorded.ts) : now()
}

function sameBody(recorded: unknown, text: string): boolean {
  return recorded === bodySha(text) || recorded === bodyShaWithoutTouches(text)
}

function parkedFilesUnder(root: string): string[] {
  return parkingTree(root).flatMap(dir => readdirSync(dir, { withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => entry.name))
}

function parkedAcrossLanes(file: string, root: string): string[] {
  const parking = path.dirname(file)
  if (!isWithin(root, parking))
    return existsSync(parking) ? readdirSync(parking) : []
  return parkedFilesUnder(root)
}

function admitConfirmation(card: SlicedCard, autoConfirm: boolean): Confirmation {
  if (!autoConfirm && admitCorrectionsNeedPerson(card))
    return tokenConfirmation()
  return confirmationOf(card, autoConfirm)
}

export function admittedCardFile(cardId: number, parkingRoot?: string): string {
  return path.join(parkingRoot ?? defaultParking(), `${cardId}.md`)
}

export interface JournalledIntake extends RecordedIntake {
  event?: unknown
}

function journalledEvent(admissions: CardAdmissionsPort, card: SlicedCard): number | null {
  const latest: JournalledIntake | null = admissions(card.id)
  return latest !== null && sameCardLine(latest.card, card.line) && sameBody(latest.bodySha, card.text) && typeof latest.event === 'number' ? latest.event : null
}

function lostWrite(cardId: number): string {
  return `#${cardId} is not admitted: after the write the journal holds no ${CARD_ADMITTED} with this card and text; read the journal and run --admit again`
}

function busBodyOf(options: AdmitOptions): string | null {
  return options.body ?? (existsSync(options.file) ? null : options.admissions?.(Number(path.basename(options.file, '.md')))?.text ?? null)
}

export function runAdmit(options: AdmitOptions, now: () => Date = () => new Date()): AdmitResult {
  let text: string
  let ownerMerges: string | null
  let published: string[] | undefined
  const busBody = busBodyOf(options)
  try {
    text = busBody ?? readFileSync(options.file, 'utf8')
    const ownerMergesFile = path.join(options.dir, OWNER_MERGES)
    ownerMerges = existsSync(ownerMergesFile) ? readFileSync(ownerMergesFile, 'utf8') : null
    const packageManifestFile = path.join(options.dir, PACKAGE_MANIFEST)
    published = existsSync(packageManifestFile) ? publishedRootsOf(readFileSync(packageManifestFile, 'utf8')) : undefined
  }
  catch (error) {
    return { status: 'refused', why: error instanceof Error ? error.message : String(error) }
  }
  const file = path.basename(options.file)
  const parsed = parseParkingFile(file, text)
  if (parsed.kind === 'refused')
    return { status: 'refused', why: parsed.reason }
  const { card } = parsed.parked.task
  const recorded: RecordedIntake | null = options.admissions?.(card.id) ?? null
  if (options.priorityEdited !== true)
    text = withKeptPriority(text, recorded?.text)
  const listed = parseCard(card.line, readMilestones(options.dir))
  if (listed.kind === 'refused')
    return { status: 'refused', why: listed.reason }
  const draft = draftOf(parsed.parked)
  const invalidPatterns = invalidTestPatterns([draft])
  if (invalidPatterns.length > 0)
    return { status: 'invalidTestPattern', reasons: invalidPatterns }
  const repository = new DirectoryFacts(options.dir, process.env.PATH ?? '')
  const nonPaths = nonPathTouchRefusals([draft], repository)
  if (nonPaths.length > 0)
    return { status: 'refused', why: nonPaths.join('; ') }
  const cards = options.cardStates?.()
  const parked = new Set(parkedNumbers(parkedAcrossLanes(options.file, options.parkingRoot ?? defaultParking())))
  const ended = endedCards(cards)
  const [checked] = checkDraft([draft], [card.id], {
    taken: new Set(),
    parked: knownCards(parked, cards),
    done: ended,
    merged: ended,
    repository,
    ...(ownerMerges === null ? {} : { ownerMerges: ownerPathsOf(ownerMerges) }),
    ...(published === undefined ? {} : { published }),
  }) as [CheckedCard]
  const masks = sharedCodeMaskRefusals(checked.touches, createdPaths(checked.creates), readContourMap(options.contourMap ?? defaultContourMap()))
  if (masks.length > 0)
    return { status: 'sharedCodeMask', reasons: masks }
  const dropped = droppedDepends(checked.depends, cards)
  if (dropped.length > 0)
    return { status: 'refused', why: dependsOnDropped(card.id, dropped) }
  const cycle = waitCycle(card.id, newlyBound(ids(checked.depends), recorded), options.cardWaits)
  if (cycle !== null)
    return { status: 'refused', why: cycle }
  const line = admittedLine(card, checked)
  const admitted: SlicedCard = {
    id: card.id,
    file,
    line,
    who: parsed.parked.who,
    seam: [],
    risk: [],
    slices: [],
    unclear: checked.unclear,
    corrections: checked.corrections,
    text: admittedText(options.writeRuns === true ? withRunsLine(text, checked.runs ?? []) : text, line, checked),
  }
  const source: AdmitSource = recorded === null ? ADMIT_SOURCE : AMEND_SOURCE
  const base = { file: options.file, card: admitted, autoConfirm: options.autoConfirm, source, inBus: options.events !== undefined, event: null, windowShard: windowShard() }
  const inJournal = (status: 'admitted' | 'alreadyAdmitted'): AdmitResult => {
    if (options.events === undefined || options.admissions === undefined)
      return { ...base, status }
    const event = journalledEvent(options.admissions, admitted)
    return event === null ? { status: 'refused', why: lostWrite(card.id) } : { ...base, status, event }
  }
  if (recorded !== null && sameCardLine(recorded.card, line) && sameBody(recorded.bodySha, admitted.text) && sameHeader(recorded.text, admitted.text, CARD_HEADER) && priorityLineOf(recorded.text ?? '') === priorityLineOf(admitted.text)) {
    if (!options.dryRun)
      options.events?.(admittedRecord(admitted, recordedConfirmation(recorded, admitted, options.autoConfirm), admittedAt(recorded, now), recordedSource(recorded)))
    return inJournal('alreadyAdmitted')
  }
  const reparsed = parseParkingFile(file, admitted.text)
  if (reparsed.kind === 'refused')
    return { status: 'refused', why: reparsed.reason }
  const waitingOn = source === ADMIT_SOURCE ? unmergedKnown(checked.depends, parked, cards, ended) : []
  if (waitingOn.length > 0 && !options.autoConfirm && admitCorrectionsNeedPerson(admitted)) {
    if (!options.dryRun)
      options.events?.(waitingEvent(card.id, waitingOn, now()))
    return { status: 'waiting', file: options.file, card: admitted, waitingOn, inBus: base.inBus, dryRun: options.dryRun }
  }
  const decisions = options.decisions ?? NO_DECISIONS
  const previous = recorded?.text === undefined ? [] : witnessesOf(recorded.text)
  const lowered = recorded?.text === undefined ? [] : unreplacedFieldDowngrades(witnessDowngrades(previous, witnessesOf(admitted.text)), previous, witnessesOf(admitted.text))
  const unreplaced = lowered.length > 0 && standingReplacementAllowed(decisions, card.id) ? unreplacedDowngrades(lowered, previous, witnessesOf(admitted.text)) : lowered
  const scope: BaseScope = { dir: options.dir, card: { touches: checked.touches, creates: createdPaths(checked.creates) }, createdAreTheChange: unreplaced.length > 0 && createdPathsAreTheChange(decisions) }
  const unrefined = unreplaced.length > 0 ? withoutRefinements(unreplaced, previous, witnessesOf(admitted.text), scope) : unreplaced
  const unmoved = unrefined.length > 0 ? withoutOwnerMoves(decisions, card.id, unrefined, previous, witnessesOf(admitted.text)) : unrefined
  const downgrades = unmoved.length > 0 && witnessTransferIsNoDowngrade(decisions) ? untransferred(unmoved, recorded?.text ?? '', openCardTextsBeside(card.id, cards, options.admissions).flatMap(other => witnessFieldsOf(other) ?? [])) : unmoved
  if (downgrades.length > 0 && !ownerAllowed(decisions, card.id, downgrades, previous)) {
    const actions = downgrades.map(witness => downgradeAction(card.id, witness, previous))
    if (!options.dryRun)
      options.events?.(downgradeEvent(card.id, downgrades, actions, bodySha(admitted.text), now()))
    return { status: 'ownerWait', file: options.file, card: admitted, downgrades, actions, command: downgradeCommand(card.id, downgrades, previous), inBus: base.inBus, dryRun: options.dryRun }
  }
  if (options.dryRun)
    return { ...base, status: 'dryRun' }
  const token = confirmationToken([admitted])
  if (!options.autoConfirm && admitCorrectionsNeedPerson(admitted) && options.confirm !== token) {
    options.events?.(heldEvent(admitted, token, now()))
    return { status: 'awaiting', file: options.file, card: admitted, token, stale: options.confirm !== undefined }
  }
  if (busBody === null && options.events === undefined && admitted.text !== text)
    writeFileSync(options.file, admitted.text)
  recordIntake([admittedRecord(admitted, admitConfirmation(admitted, options.autoConfirm), now(), source)], options.events)
  const result = inJournal('admitted')
  if (result.status === 'admitted' && waitingOn.length > 0)
    options.events?.(waitingEvent(card.id, waitingOn, now()))
  if (result.status === 'admitted')
    recordIntake(windowEvent(admitted, now()), options.events)
  return result
}

function printJournalledEvent(ui: Ui, event: number | null): void {
  if (event !== null)
    ui.line(ui.theme.dim(`  ${ui.lore.intakeAdmittedEvent(event)}`))
}

export function printAdmit(ui: Ui, result: AdmitResult): number {
  if (result.status === 'refused') {
    ui.flatline(ui.lore.intakeRefusedUnreadable(result.why))
    return INTAKE_EXIT.refused
  }
  if (result.status === 'invalidTestPattern' || result.status === 'sharedCodeMask') {
    ui.flatline(REFUSED_WITH_REASONS[result.status](ui.lore))
    for (const reason of result.reasons)
      ui.line(`  - ${reason}`)
    return INTAKE_EXIT.refused
  }
  const { card } = result
  if (result.status === 'waiting') {
    const depends = result.waitingOn.map(id => `#${id}`).join(', ')
    ui.line(result.dryRun ? ui.lore.intakeAdmitWaitingDryRun(result.file, card.line, depends) : ui.lore.intakeAdmitWaiting(result.file, card.line, depends, result.inBus))
    return INTAKE_EXIT.waiting
  }
  if (result.status === 'ownerWait') {
    ui.line(result.dryRun ? ui.lore.intakeAdmitDowngradeDryRun(result.file, card.line, result.downgrades.length) : ui.lore.intakeAdmitDowngrade(result.file, card.line, result.downgrades.length, result.inBus))
    for (const action of result.actions)
      ui.line(`  - ${ui.lore.intakeAdmitDowngradeAction(card.id, action)}`)
    ui.line(`  ${result.command}`)
    return INTAKE_EXIT.waiting
  }
  if (result.status === 'alreadyAdmitted') {
    ui.ok(ui.lore.intakeAlreadyAdmitted(result.file, card.line, result.inBus))
    printJournalledEvent(ui, result.event)
    return INTAKE_EXIT.alreadyAdmitted
  }
  if (result.status === 'awaiting' && result.stale)
    ui.flatline(ui.lore.intakeConfirmStale)
  if (result.status === 'dryRun')
    ui.line(card.text)
  else if (result.status === 'awaiting')
    ui.line(ui.lore.intakeAwaitingCard(card.line))
  else if (result.source === AMEND_SOURCE)
    ui.ok(ui.lore.intakeAmended(result.file, card.line, result.inBus))
  else
    ui.ok(ui.lore.intakeAdmitted(result.file, card.line, result.inBus))
  if (result.status === 'admitted')
    printJournalledEvent(ui, result.event)
  if (result.status !== 'dryRun') {
    for (const correction of card.corrections)
      ui.line(ui.theme.dim(`  ${ui.lore.intakeCorrected(correctionText(correction))}`))
  }
  if (card.corrections.length > 0 && result.status === 'admitted')
    ui.line(ui.theme.dim(`  ${ui.lore.intakeConfirmed(card.corrections.length, result.autoConfirm, result.inBus, result.windowShard)}`))
  if (card.unclear.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.intakeAdmitUnclear(card.unclear.length)}`))
  if (result.status === 'dryRun')
    ui.line(ui.lore.intakeAdmitDryRun(result.file))
  if (result.status === 'awaiting')
    ui.line(ui.lore.intakeAdmitAwaiting(result.file, result.token))
  return INTAKE_EXIT[result.status]
}
