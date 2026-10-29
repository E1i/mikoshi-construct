import type { BusCardStates } from '../../card/closed.js'
import type { Card, Decision } from '../../card/grammar.js'
import type { ParkedTask } from '../../card/parking.js'
import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { CheckedCard } from './check.js'
import type { Confirmation } from './confirm.js'
import type { DraftCard, WitnessKind } from './draft.js'
import type { CardAdmissionsPort, CardEvent, CardEventPort, CardStatesPort, RecordedIntake } from './index.js'
import type { SlicedCard } from './slice.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { decisionsFileOf, defaultBusPath } from '../../../scripts/core/bus-path.js'
import { CARD_WAITING, WITNESS_DOWNGRADE } from '../../../scripts/core/events.js'
import { endedCards } from '../../card/closed.js'
import { pathsIn, pathsOutside } from '../../card/covering-tests.js'
import { cardLine, parseCard } from '../../card/grammar.js'
import { createdPaths, parseParkingFile } from '../../card/parking.js'
import { PREFIX_SUFFIX } from '../../card/task-file.js'
import { readMilestones } from '../../manifest.js'
import { CARD_REFERENCE, checkDraft, correctionText, invalidTestPatterns, OWNER_MERGES, ownerPathsOf, PACKAGE_MANIFEST, publishedRootsOf } from './check.js'
import { admitCorrectionsNeedPerson, bodySha, bodyShaWithoutTouches, confirmationOf, confirmationToken, TOUCHES_HEADER } from './confirm.js'
import { withoutWitnessKind, witnessKindField } from './draft.js'
import { DirectoryFacts } from './facts.js'
import { admittedRecord, defaultParking, INTAKE_EXIT, recordIntake } from './index.js'
import { parkedNumbers } from './numbers.js'
import { isWithin, parkingTree } from './parking-tree.js'
import { defaultContourMap, readContourMap, sharedCodeMaskRefusals } from './shared-code-masks.js'
import { CORRECTED_PREFIX, UNCLEAR_PREFIX, WITNESSES_HEADING } from './slice.js'

const WITNESS_ITEM = /^- (.+)$/
const BLOCKS_SEPARATOR = ' · blocks '
const LEADING_BLOCKS = /^(?:—|#\d+(?:,? #\d+)*)/
const CARD_HEADER = 'card: '
export const ADMIT_SOURCE = 'admit'
const LANE_NAME = /^(?:(?:lane|night)(?:-[\w.-]+)?|\d{4}-\d{2}-\d{2}-[a-z]+)$/

export function isLaneName(name: string): boolean {
  return LANE_NAME.test(name)
}

export function pathsNamedOutside(parked: ParkedTask, text: string): string[] {
  return pathsOutside(parked.task.touches, parked.creates, pathsIn(text))
}

export function laneOf(root: string, dir: string): string | null {
  const name = path.basename(dir)
  return path.dirname(path.resolve(dir)) === path.resolve(root) && isLaneName(name) ? name : null
}

export const LANE_FILE = 'lane.json'
export const LANE_CREATED_BY = 'intake'
const NUMBERED_LANE = /^lane-(\d{2,})$/
const OPEN_LANE = 'open'
const ADDITIVE_ROOTS = ['tests', 'scripts/tests', '.changeset']
const PARKED_CARD = /^\d+\.md$/

export function laneName(number: number): string {
  return `lane-${String(number).padStart(2, '0')}`
}

export function laneNumber(name: string): number | null {
  const number = NUMBERED_LANE.exec(name)?.[1]
  return number === undefined ? null : Number(number)
}

function scopeOf(touch: string): { path: string, mask: boolean } {
  return touch.endsWith(PREFIX_SUFFIX) ? { path: touch.slice(0, -PREFIX_SUFFIX.length), mask: true } : { path: touch, mask: false }
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`)
}

function touchConflict(a: string, b: string): boolean {
  const left = scopeOf(a)
  const right = scopeOf(b)
  const additive = ADDITIVE_ROOTS.some(root => within(root, left.path)) && ADDITIVE_ROOTS.some(root => within(root, right.path))
  if (additive && (left.mask || right.mask))
    return false
  return a === b || (left.mask && within(left.path, right.path)) || (right.mask && within(right.path, left.path))
}

function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some(left => b.some(right => touchConflict(left, right)))
}

function declaredTouches(lane: string): string[] {
  const file = path.join(lane, LANE_FILE)
  if (!existsSync(file))
    return []
  try {
    const touches = (JSON.parse(readFileSync(file, 'utf8')) as { touches?: unknown } | null)?.touches
    return Array.isArray(touches) ? touches.filter(touch => typeof touch === 'string') : []
  }
  catch {
    return []
  }
}

function parkedTasks(lane: string): ParkedTask[] {
  return readdirSync(lane).filter(name => PARKED_CARD.test(name)).flatMap((name) => {
    const parsed = parseParkingFile(name, readFileSync(path.join(lane, name), 'utf8'))
    return parsed.kind === 'parked' ? [parsed.parked] : []
  })
}

export function laneTouches(lane: string): string[] {
  return [...new Set([...declaredTouches(lane), ...parkedTasks(lane).flatMap(parked => parked.task.touches)])].sort()
}

function lanesUnder(root: string): string[] {
  if (!existsSync(root))
    return []
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && isLaneName(entry.name)).map(entry => entry.name).sort()
}

function openLane(root: string, card: ParkedTask, at: Date): string {
  const lane = laneName(Math.max(0, ...lanesUnder(root).map(name => laneNumber(name) ?? 0)) + 1)
  const dir = path.join(root, lane)
  mkdirSync(dir, { recursive: true })
  const record = { purpose: card.task.card.line, touches: card.task.touches, createdBy: LANE_CREATED_BY, createdAt: at.toISOString(), status: OPEN_LANE }
  writeFileSync(path.join(dir, LANE_FILE), `${JSON.stringify(record, null, 2)}\n`)
  return lane
}

export function layLane(root: string, card: ParkedTask, at: Date): string {
  const lanes = lanesUnder(root)
  const dependedOn = lanes.find(lane => card.task.card.depends.some(id => existsSync(path.join(root, lane, `${id}.md`))))
  return dependedOn ?? lanes.find(lane => touchesOverlap(laneTouches(path.join(root, lane)), card.task.touches)) ?? openLane(root, card, at)
}
export const AMEND_SOURCE = 'amend'

type AdmitSource = typeof ADMIT_SOURCE | typeof AMEND_SOURCE

export interface AdmitOptions {
  file: string
  dir: string
  dryRun: boolean
  confirm?: string
  autoConfirm: boolean
  parkingRoot?: string
  contourMap?: string
  events?: CardEventPort
  cardStates?: CardStatesPort
  admissions?: CardAdmissionsPort
  decisions?: string
}

type RefusedWithReasons = 'invalidTestPattern' | 'sharedCodeMask'

const REFUSED_WITH_REASONS: Record<RefusedWithReasons, (lore: Lore) => string> = {
  invalidTestPattern: lore => lore.intakeRefusedInvalidTestPattern,
  sharedCodeMask: lore => lore.intakeRefusedSharedCodeMask,
}

export type AdmitResult
  = | { status: 'refused', why: string }
    | { status: 'invalidTestPattern', reasons: string[] }
    | { status: 'sharedCodeMask', reasons: string[] }
    | { status: 'admitted' | 'alreadyAdmitted' | 'dryRun', file: string, card: SlicedCard, autoConfirm: boolean, source: AdmitSource, inBus: boolean }
    | { status: 'awaiting', file: string, card: SlicedCard, token: string, stale: boolean }
    | { status: 'waiting', file: string, card: SlicedCard, waitingOn: number[], inBus: boolean, dryRun: boolean }
    | { status: 'ownerWait', file: string, card: SlicedCard, downgrades: string[], inBus: boolean, dryRun: boolean }

const RED_ON_MAIN = /[;,]?\s*red on main/i
const ACCEPTANCE: WitnessKind = 'acceptance'
const ANY_FORM_OF_FAILING_ON_MAIN = /(?:\s*[;,—–-])?\s*(?:red|non-zero) on main/i
const DOWNGRADE_ALLOWANCE = 'разрешить понижение свидетеля'
const DECISION_LINE = /^- D-[1-9]\d* · /
const DECISION_CARDS = / · card (#[1-9]\d*(?: #[1-9]\d*)*)/
const SUPERSEDED_BY = ' · superseded-by D-'
const DROPPED_CARD = 'dropped'

export function defaultDecisions(): string {
  return decisionsFileOf(defaultBusPath())
}

export function downgradeAction(cardId: number, witness: string): string {
  return `${DOWNGRADE_ALLOWANCE} ${witness} у #${cardId}`
}

function witnessCore(witness: string): string {
  return withoutWitnessKind(witness).replace(ANY_FORM_OF_FAILING_ON_MAIN, '').trim()
}

export function isAcceptanceWitness(witness: string): boolean {
  return (witnessKindField(witness) ?? (RED_ON_MAIN.test(witness) ? ACCEPTANCE : undefined)) === ACCEPTANCE
}

export function witnessDowngrades(previous: readonly string[], next: readonly string[]): string[] {
  const acceptanceByCore = new Map(next.map(witness => [witnessCore(witness), isAcceptanceWitness(witness)]))
  return previous.filter((witness) => {
    const acceptance = acceptanceByCore.get(witnessCore(witness))
    return acceptance === undefined || (isAcceptanceWitness(witness) && !acceptance)
  })
}

export function witnessesOf(body: string): string[] {
  const lines = body.split('\n')
  const at = lines.findIndex(line => line.trim() === WITNESSES_HEADING)
  if (at === -1)
    return []
  const items: string[] = []
  for (const line of lines.slice(at + 1)) {
    const item = WITNESS_ITEM.exec(line.trim())?.[1]
    if (item === undefined)
      break
    items.push(item)
  }
  return items
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

function waitingEvent(cardId: number, waitingOn: readonly number[], at: Date): CardEvent {
  return { type: CARD_WAITING, cardId, ts: at.toISOString(), dedupeKey: `${CARD_WAITING}:${cardId}:${waitingOn.join(',')}`, payload: { depends: waitingOn } }
}

function downgradeEvent(cardId: number, downgrades: readonly string[], sha: string, at: Date): CardEvent {
  return { type: CARD_WAITING, cardId, ts: at.toISOString(), dedupeKey: `${CARD_WAITING}:${WITNESS_DOWNGRADE}:${cardId}:${sha}`, payload: { reason: WITNESS_DOWNGRADE, witnesses: downgrades, actions: downgrades.map(witness => downgradeAction(cardId, witness)), bodySha: sha } }
}

function ownerAllowed(decisionsFile: string, cardId: number, downgrades: readonly string[]): boolean {
  if (!existsSync(decisionsFile))
    return false
  const allowing = readFileSync(decisionsFile, 'utf8').split('\n').filter(line => DECISION_LINE.test(line) && !line.includes(SUPERSEDED_BY) && (DECISION_CARDS.exec(line)?.[1]?.split(' ').includes(`#${cardId}`) ?? false))
  return downgrades.every(witness => allowing.some(line => line.includes(downgradeAction(cardId, witness))))
}

function blocksTail(line: string): string {
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

function latestIntake(card: Card, admissions: CardAdmissionsPort | undefined): RecordedIntake | null {
  return admissions?.(card.id) ?? null
}

function sameCardLine(recorded: string, line: string): boolean {
  const parsed = parseCard(line)
  const wanted = parsed.kind === 'card' ? cardLine(parsed.card) : line
  const recordedCard = parseCard(recorded)
  return recordedCard.kind === 'card' && cardLine(recordedCard.card) === wanted
}

const RECORDED_CONFIRMATION: Record<Confirmation, Confirmation> = { auto: 'auto', person: 'person', none: 'none' }

function recordedConfirmation(recorded: RecordedIntake, card: SlicedCard, autoConfirm: boolean): Confirmation {
  const { confirmation } = recorded
  return typeof confirmation === 'string' && Object.hasOwn(RECORDED_CONFIRMATION, confirmation) ? RECORDED_CONFIRMATION[confirmation as Confirmation] : confirmationOf(card, autoConfirm)
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
    return 'person'
  return confirmationOf(card, autoConfirm)
}

function busBodyOf(options: AdmitOptions): string | null {
  if (existsSync(options.file))
    return null
  return options.admissions?.(Number(path.basename(options.file, '.md')))?.text ?? null
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
  const listed = parseCard(card.line, readMilestones(options.dir))
  if (listed.kind === 'refused')
    return { status: 'refused', why: listed.reason }
  const draft = draftOf(parsed.parked)
  const invalidPatterns = invalidTestPatterns([draft])
  if (invalidPatterns.length > 0)
    return { status: 'invalidTestPattern', reasons: invalidPatterns }
  const cards = options.cardStates?.()
  const parked = new Set(parkedNumbers(parkedAcrossLanes(options.file, options.parkingRoot ?? defaultParking())))
  const ended = endedCards(cards)
  const [checked] = checkDraft([draft], [card.id], {
    taken: new Set(),
    parked: new Set([...parked, ...[...(cards?.keys() ?? [])].map(Number)]),
    done: ended,
    merged: ended,
    repository: new DirectoryFacts(options.dir, process.env.PATH ?? ''),
    ...(ownerMerges === null ? {} : { ownerMerges: ownerPathsOf(ownerMerges) }),
    ...(published === undefined ? {} : { published }),
  }) as [CheckedCard]
  const masks = sharedCodeMaskRefusals(checked.touches, createdPaths(checked.creates), readContourMap(options.contourMap ?? defaultContourMap()))
  if (masks.length > 0)
    return { status: 'sharedCodeMask', reasons: masks }
  const dropped = droppedDepends(checked.depends, cards)
  if (dropped.length > 0)
    return { status: 'refused', why: dependsOnDropped(card.id, dropped) }
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
    text: admittedText(text, line, checked),
  }
  const recorded = latestIntake(card, options.admissions)
  const source: AdmitSource = recorded === null ? ADMIT_SOURCE : AMEND_SOURCE
  const base = { file: options.file, card: admitted, autoConfirm: options.autoConfirm, source, inBus: options.events !== undefined }
  const lane = laneOf(options.parkingRoot ?? defaultParking(), path.dirname(options.file))
  if (recorded !== null && sameCardLine(recorded.card, line) && sameBody(recorded.bodySha, admitted.text)) {
    if (!options.dryRun)
      options.events?.(admittedRecord(admitted, recordedConfirmation(recorded, admitted, options.autoConfirm), admittedAt(recorded, now), lane, recordedSource(recorded)))
    return { ...base, status: 'alreadyAdmitted' }
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
  const downgrades = recorded?.text === undefined ? [] : witnessDowngrades(witnessesOf(recorded.text), witnessesOf(admitted.text))
  if (downgrades.length > 0 && !ownerAllowed(options.decisions ?? defaultDecisions(), card.id, downgrades)) {
    if (!options.dryRun)
      options.events?.(downgradeEvent(card.id, downgrades, bodySha(admitted.text), now()))
    return { status: 'ownerWait', file: options.file, card: admitted, downgrades, inBus: base.inBus, dryRun: options.dryRun }
  }
  if (options.dryRun)
    return { ...base, status: 'dryRun' }
  const token = confirmationToken([admitted])
  if (!options.autoConfirm && admitCorrectionsNeedPerson(admitted) && options.confirm !== token)
    return { status: 'awaiting', file: options.file, card: admitted, token, stale: options.confirm !== undefined }
  if (busBody === null && options.events === undefined && admitted.text !== text)
    writeFileSync(options.file, admitted.text)
  recordIntake([admittedRecord(admitted, admitConfirmation(admitted, options.autoConfirm), now(), lane, source)], options.events)
  if (waitingOn.length > 0)
    options.events?.(waitingEvent(card.id, waitingOn, now()))
  return { ...base, status: 'admitted' }
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
    for (const witness of result.downgrades)
      ui.line(`  - ${ui.lore.intakeAdmitDowngradeAction(card.id, downgradeAction(card.id, witness))}`)
    return INTAKE_EXIT.waiting
  }
  if (result.status === 'alreadyAdmitted') {
    ui.ok(ui.lore.intakeAlreadyAdmitted(result.file, card.line, result.inBus))
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
  if (result.status !== 'dryRun') {
    for (const correction of card.corrections)
      ui.line(ui.theme.dim(`  ${ui.lore.intakeCorrected(correctionText(correction))}`))
  }
  if (card.corrections.length > 0 && result.status === 'admitted')
    ui.line(ui.theme.dim(`  ${ui.lore.intakeConfirmed(card.corrections.length, result.autoConfirm, result.inBus)}`))
  if (card.unclear.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.intakeAdmitUnclear(card.unclear.length)}`))
  if (result.status === 'dryRun')
    ui.line(ui.lore.intakeAdmitDryRun(result.file))
  if (result.status === 'awaiting')
    ui.line(ui.lore.intakeAdmitAwaiting(result.file, result.token))
  return INTAKE_EXIT[result.status]
}
