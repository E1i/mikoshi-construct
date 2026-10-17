import type { Ui } from '../../ui/console.js'
import type { CardEventPort } from './index.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { parseParkingFile } from '../../card/parking.js'
import { bodySha } from './confirm.js'
import { CARD_MOVED, INTAKE_EXIT, recordIntake } from './index.js'

export const INTAKE_MOVE_EVENT = 'intake-move'

const CARD_NUMBER = /^#?(\d+)$/

export interface MoveOptions {
  move: string | undefined
  to: string | undefined
  draft: string | undefined
  taken: string | undefined
  admit: string | undefined
  parking: string
  journal: string
  events?: CardEventPort
}

export type MoveResult
  = | { status: 'refused', why: (ui: Ui) => string }
    | { status: 'moved', from: string, to: string }
    | { status: 'recordedInPlace', file: string }

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
  if (!existsSync(options.parking))
    return refused(ui => ui.lore.intakeMoveNotFound(number))
  const found = holdersOf(number, directoriesOf(options.parking))
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
  if (!inPlace) {
    mkdirSync(targetDir, { recursive: true })
    renameSync(from, target)
  }
  const ts = now().toISOString()
  const moved = { from: path.dirname(from), to: targetDir, bodySha: bodySha(text) }
  try {
    recordIntake(options.journal, [{
      journalLine: JSON.stringify({ event: INTAKE_MOVE_EVENT, task: String(number), ...moved, ts }),
      event: { type: CARD_MOVED, cardId: number, ts, dedupeKey: `${CARD_MOVED}:${number}:${targetDir}:${ts}`, payload: { ...moved, lane: path.basename(targetDir) } },
    }], options.events)
  }
  catch (error) {
    if (!inPlace)
      renameSync(target, from)
    throw error
  }
  return inPlace ? { status: 'recordedInPlace', file: target } : { status: 'moved', from, to: target }
}

export function printMove(ui: Ui, result: MoveResult): number {
  if (result.status === 'refused') {
    ui.flatline(result.why(ui))
    return INTAKE_EXIT.refused
  }
  ui.ok(result.status === 'moved' ? ui.lore.intakeMoved(result.from, result.to) : ui.lore.intakeMoveRecordedInPlace(result.file))
  return INTAKE_EXIT.admitted
}
