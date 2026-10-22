import type { Ui } from '../../ui/console.js'
import type { CardAdmissionsPort, CardEventPort } from './index.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { CARD_DROPPED, CARD_MOVED, INTAKE_MOVE_EVENT, TERMINAL_LANES } from '../../../scripts/core/events.js'
import { parseParkingFile } from '../../card/parking.js'
import { bodySha } from './confirm.js'
import { INTAKE_EXIT, recordIntake } from './index.js'

export const CARD_NUMBER = /^#?(\d+)$/

export interface MoveOptions {
  move: string | undefined
  to: string | undefined
  draft: string | undefined
  taken: string | undefined
  admit: string | undefined
  parking: string
  journal: string
  events?: CardEventPort
  admissions?: CardAdmissionsPort
}

export type MoveResult
  = | { status: 'refused', why: (ui: Ui) => string }
    | { status: 'moved', from: string, to: string, event: string }
    | { status: 'recordedInPlace', file: string, event: string }

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

function moveType(targetDir: string): typeof CARD_MOVED | typeof CARD_DROPPED {
  return TERMINAL_LANES.has(path.basename(targetDir)) ? CARD_DROPPED : CARD_MOVED
}

function recordMove(options: MoveOptions, number: number, moved: Moved, ts: string): void {
  const type = moveType(moved.to)
  const lane = path.basename(moved.to)
  recordIntake(options.journal, [{
    journalLine: JSON.stringify({ event: INTAKE_MOVE_EVENT, task: String(number), ...moved, ts }),
    event: { type, cardId: number, ts, dedupeKey: `${type}:${number}:${lane}:${ts}`, payload: { ...moved, lane } },
  }], options.events)
}

function moveInBus(options: MoveOptions, number: number, text: string, now: () => Date): MoveResult {
  const to = path.resolve(options.parking, options.to!)
  recordMove(options, number, { from: null, to, bodySha: bodySha(text) }, now().toISOString())
  return { status: 'moved', from: `#${number}`, to, event: moveType(to) }
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
  const parsed = parseParkingFile(path.basename(from), text)
  if (parsed.kind === 'refused')
    return refused(ui => ui.lore.intakeRefusedUnreadable(`${from}: ${parsed.reason}`))
  const inPlace = path.resolve(from) === target
  const createdDir = inPlace ? undefined : mkdirSync(targetDir, { recursive: true })
  if (!inPlace)
    renameSync(from, target)
  const ts = now().toISOString()
  const moved = { from: path.dirname(from), to: targetDir, bodySha: bodySha(text) }
  const type = moveType(targetDir)
  try {
    recordMove(options, number, moved, ts)
  }
  catch (error) {
    if (!inPlace)
      renameSync(target, from)
    if (createdDir !== undefined)
      rmdirSync(createdDir)
    throw error
  }
  return inPlace ? { status: 'recordedInPlace', file: target, event: type } : { status: 'moved', from, to: target, event: type }
}

export function printMove(ui: Ui, result: MoveResult): number {
  if (result.status === 'refused') {
    ui.flatline(result.why(ui))
    return INTAKE_EXIT.refused
  }
  ui.ok(result.status === 'moved' ? ui.lore.intakeMoved(result.from, result.to, result.event) : ui.lore.intakeMoveRecordedInPlace(result.file, result.event))
  return INTAKE_EXIT.admitted
}
