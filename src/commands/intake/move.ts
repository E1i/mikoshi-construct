import type { Ui } from '../../ui/console.js'
import type { CardAdmissionsPort, CardEvent, CardEventPort, CardStatesPort, RecordedIntake } from './index.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { CARD_DEFERRED, CARD_DROPPED, CARD_MOVED, DEFERRED_TARGET } from '../../../scripts/core/events.js'
import { ENDED_IN_BUS } from '../../card/closed.js'
import { parseParkingFile } from '../../card/parking.js'
import { AMEND_SOURCE, laneOf } from './admit.js'
import { admittedCardOf, withRepointedDepends } from './amend.js'
import { bodySha, bodyShaWithoutTouches, isConfirmation } from './confirm.js'
import { admittedRecord, INTAKE_EXIT, recordIntake } from './index.js'

export const CARD_NUMBER = /^#?(\d+)$/
const SLICED_STUB = /^sliced into (#\d+(?:,\s*#\d+)*)$/
const DATED_PARKING = /^\d{4}-\d{2}-\d{2}-[a-z]{2,}$/
const DROPPED_IN_BUS = 'dropped'
const CARD_IN_BUS = /^\d+$/

export interface MoveOptions {
  move: string | undefined
  to: string | undefined
  draft: string | undefined
  taken: string | undefined
  admit: string | undefined
  parking: string
  dryRun?: boolean
  events?: CardEventPort
  admissions?: CardAdmissionsPort
  cardStates?: CardStatesPort
}

export interface Repointed { card: number, dropped: number, children: number[] }

export type MoveResult
  = | { status: 'refused', why: (ui: Ui) => string }
    | { status: 'moved', from: string, to: string, event: string, repointed?: Repointed[] }
    | { status: 'dryRun', parking: string, from: string, to: string, event: string, repointed?: Repointed[] }
    | { status: 'recordedInPlace', file: string, event: string, repointed?: Repointed[] }

function refused(why: (ui: Ui) => string): MoveResult {
  return { status: 'refused', why }
}

function directoriesOf(root: string): string[] {
  const subdirectories = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  return [root, ...subdirectories.map(entry => path.join(root, entry.name))]
}

function holdersOf(id: number, directories: readonly string[]): string[] {
  return directories.map(dir => path.join(dir, `${id}.md`)).filter(file => existsSync(file))
}

function isParkingDirectoryName(to: string): boolean {
  return to === '.' || (to !== '..' && to !== '' && !/[/\\]/.test(to))
}

interface Moved { from: string | null, to: string, bodySha: string }

interface Slicing { reason: string, children: number[] }

function slicingOf(text: string): Slicing | null {
  const reason = text.trim()
  const children = SLICED_STUB.exec(reason)?.[1]
  return children === undefined ? null : { reason, children: children.split(',').map(child => Number(child.trim().slice(1))) }
}

function isLaunchLane(parking: string, targetDir: string): boolean {
  const lane = laneOf(parking, targetDir)
  return lane !== null && !DATED_PARKING.test(lane)
}

function isDeferredTarget(parking: string, targetDir: string): boolean {
  return path.relative(parking, targetDir) === DEFERRED_TARGET
}

function moveType(parking: string, targetDir: string, slicing: Slicing | null): typeof CARD_MOVED | typeof CARD_DEFERRED | typeof CARD_DROPPED {
  if (slicing !== null)
    return CARD_DROPPED
  if (isDeferredTarget(parking, targetDir))
    return CARD_DEFERRED
  return isLaunchLane(parking, targetDir) ? CARD_MOVED : CARD_DROPPED
}

function recordMove(options: MoveOptions, number: number, moved: Moved, slicing: Slicing | null, ts: string): void {
  const type = moveType(options.parking, moved.to, slicing)
  const lane = path.basename(moved.to)
  recordIntake([{ type, cardId: number, ts, dedupeKey: `${type}:${number}:${lane}:${ts}`, payload: { ...moved, lane, ...slicing } } as CardEvent], options.events)
}

interface Repointing extends Repointed { admission: RecordedIntake, text: string }

type DependentsReading = { kind: 'repoint', repointings: Repointing[] } | { kind: 'refused', orphans: number[] }

function openInBus(states: ReadonlyMap<string, string> | undefined, card: number): boolean {
  const state = states?.get(String(card))
  return state === undefined || (!ENDED_IN_BUS.has(state) && state !== DROPPED_IN_BUS)
}

function linksOf(options: MoveOptions, card: number): { blocks: number[], depends: number[] } {
  const text = options.admissions?.(card)?.text
  const admitted = text === undefined ? null : admittedCardOf(text)
  return { blocks: admitted?.blocks ?? [], depends: admitted?.depends ?? [] }
}

function takesOver(options: MoveOptions, child: number, card: number): boolean {
  const links = linksOf(options, child)
  return links.blocks.includes(card) && !links.depends.includes(card)
}

function candidatesOf(options: MoveOptions, dropped: number, slicing: Slicing, states: ReadonlyMap<string, string> | undefined): number[] {
  const held = [...(states ?? new Map<string, string>()).keys()].flatMap(card => CARD_IN_BUS.test(card) ? [Number(card)] : [])
  const named = slicing.children.flatMap(child => linksOf(options, child).blocks)
  return [...new Set([...held, ...named])].filter(card => card !== dropped && !slicing.children.includes(card) && openInBus(states, card)).sort((a, b) => a - b)
}

function dependentsOf(options: MoveOptions, dropped: number, slicing: Slicing): DependentsReading {
  const states = options.cardStates?.()
  const repointings: Repointing[] = []
  const orphans: number[] = []
  for (const card of candidatesOf(options, dropped, slicing, states)) {
    const admission = options.admissions?.(card)
    const depends = admission?.text === undefined ? [] : admittedCardOf(admission.text)?.depends ?? []
    if (admission?.text === undefined || !depends.includes(dropped))
      continue
    const children = slicing.children.filter(child => takesOver(options, child, card))
    const text = children.length === 0 ? null : withRepointedDepends(admission.text, dropped, children)
    if (text === null)
      orphans.push(card)
    else
      repointings.push({ card, dropped, children, admission, text })
  }
  return orphans.length > 0 ? { kind: 'refused', orphans } : { kind: 'repoint', repointings }
}

function repointedRecord(repointing: Repointing, at: Date): CardEvent {
  const card = admittedCardOf(repointing.text)!
  const { confirmation } = repointing.admission
  const sliced = { id: repointing.card, file: `${repointing.card}.md`, line: card.line, who: '', unclear: [], corrections: [], seam: [], risk: [], slices: [], text: repointing.text }
  return admittedRecord(sliced, isConfirmation(confirmation) ? confirmation : 'auto', at, null, AMEND_SOURCE)
}

function repointedOnly(repointings: readonly Repointing[]): { repointed?: Repointed[] } {
  return repointings.length === 0 ? {} : { repointed: repointings.map(({ card, dropped, children }) => ({ card, dropped, children })) }
}

function orphansRefusal(dropped: number, orphans: readonly number[]): MoveResult {
  const cards = orphans.map(card => `#${card}`).join(', ')
  return refused(ui => ui.lore.intakeDropLeavesDependents(dropped, cards))
}

function projectionLagsTheJournal(admission: RecordedIntake | null | undefined): boolean {
  return admission?.text !== undefined && admission.bodySha !== bodySha(admission.text) && admission.bodySha !== bodyShaWithoutTouches(admission.text)
}

function latestAdmittedSha(options: MoveOptions, number: number, parkedText: string): string {
  const latest = options.admissions?.(number)?.bodySha
  return typeof latest === 'string' ? latest : bodySha(parkedText)
}

function staleBodyRefusal(options: MoveOptions, number: number, targetDir: string, slicing: Slicing | null): MoveResult | null {
  if (moveType(options.parking, targetDir, slicing) !== CARD_MOVED || !projectionLagsTheJournal(options.admissions?.(number)))
    return null
  return refused(ui => ui.lore.intakeRefusedUnreadable(`#${number}: the card_bodies projection holds an older body than the latest card.admitted, and a move would re-admit it; run it again once the reducer has folded that admission`))
}

function moveInBus(options: MoveOptions, number: number, text: string, now: () => Date): MoveResult {
  const to = path.resolve(options.parking, options.to!)
  const stale = staleBodyRefusal(options, number, to, null)
  if (stale !== null)
    return stale
  if (options.dryRun === true)
    return { status: 'dryRun', parking: options.parking, from: `#${number}`, to, event: moveType(options.parking, to, null) }
  recordMove(options, number, { from: null, to, bodySha: latestAdmittedSha(options, number, text) }, null, now().toISOString())
  return { status: 'moved', from: `#${number}`, to, event: moveType(options.parking, to, null) }
}

export function runMove(options: MoveOptions, now: () => Date = () => new Date()): MoveResult {
  const id = options.move === undefined ? null : CARD_NUMBER.exec(options.move)?.[1]
  if (id === null || id === undefined || options.to === undefined || options.draft !== undefined || options.taken !== undefined || options.admit !== undefined)
    return refused(ui => ui.lore.intakeMoveNeedsBoth)
  if (options.events === undefined)
    return refused(ui => ui.lore.intakeMoveNeedsTheBus)
  if (!isParkingDirectoryName(options.to)) {
    const to = options.to
    return refused(ui => ui.lore.intakeMoveTargetOutside(to))
  }
  const number = Number(id)
  const found = existsSync(options.parking) ? holdersOf(number, directoriesOf(options.parking)) : []
  const busText = found.length === 0 ? options.admissions?.(number)?.text : undefined
  if (busText !== undefined)
    return moveInBus(options, number, busText, now)
  if (found.length === 0)
    return refused(ui => ui.lore.intakeMoveNotFound(number))
  if (found.length > 1)
    return refused(ui => ui.lore.intakeMoveAmbiguous(number, found.join(', ')))
  const from = found[0]!
  const targetDir = path.resolve(options.parking, options.to)
  const target = path.join(targetDir, path.basename(from))
  const text = readFileSync(from, 'utf8')
  const slicing = slicingOf(text)
  const parsed = slicing === null ? parseParkingFile(path.basename(from), text) : null
  if (parsed?.kind === 'refused')
    return refused(ui => ui.lore.intakeRefusedUnreadable(`${from}: ${parsed.reason}`))
  const stale = staleBodyRefusal(options, number, targetDir, slicing)
  if (stale !== null)
    return stale
  const dependents = slicing === null ? { kind: 'repoint' as const, repointings: [] } : dependentsOf(options, number, slicing)
  if (dependents.kind === 'refused')
    return orphansRefusal(number, dependents.orphans)
  const repointed = repointedOnly(dependents.repointings)
  if (options.dryRun === true)
    return { status: 'dryRun', parking: options.parking, from, to: target, event: moveType(options.parking, targetDir, slicing), ...repointed }
  const at = now()
  const inPlace = path.resolve(from) === target
  const createdDir = inPlace ? undefined : mkdirSync(targetDir, { recursive: true })
  if (!inPlace)
    renameSync(from, target)
  const ts = at.toISOString()
  const moved = { from: path.dirname(from), to: targetDir, bodySha: latestAdmittedSha(options, number, text) }
  const type = moveType(options.parking, targetDir, slicing)
  try {
    recordIntake(dependents.repointings.map(repointing => repointedRecord(repointing, at)), options.events)
    recordMove(options, number, moved, slicing, ts)
  }
  catch (error) {
    if (!inPlace)
      renameSync(target, from)
    if (createdDir !== undefined)
      rmdirSync(createdDir)
    throw error
  }
  return inPlace ? { status: 'recordedInPlace', file: target, event: type, ...repointed } : { status: 'moved', from, to: target, event: type, ...repointed }
}

function printRepointed(ui: Ui, repointed: readonly Repointed[] | undefined): void {
  for (const { card, dropped, children } of repointed ?? [])
    ui.line(ui.lore.intakeDropRepointed(card, dropped, children.map(child => `#${child}`).join(', ')))
}

export function printMove(ui: Ui, result: MoveResult): number {
  if (result.status === 'refused') {
    ui.flatline(result.why(ui))
    return INTAKE_EXIT.refused
  }
  if (result.status === 'dryRun') {
    ui.line(`${result.from} -> ${result.to} (${result.event})`)
    printRepointed(ui, result.repointed)
    ui.line(ui.lore.intakeDryRun(result.parking))
    return INTAKE_EXIT.dryRun
  }
  ui.ok(result.status === 'moved' ? ui.lore.intakeMoved(result.from, result.to, result.event) : ui.lore.intakeMoveRecordedInPlace(result.file, result.event))
  printRepointed(ui, result.repointed)
  return INTAKE_EXIT.admitted
}
