import type { Ui } from '../../ui/console.js'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { parseParkingFile } from '../../card/parking.js'
import { bodySha } from './confirm.js'
import { INTAKE_EXIT } from './index.js'

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
}

export type MoveResult
  = | { status: 'refused', why: (ui: Ui) => string }
    | { status: 'moved', from: string, to: string }

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
  const targetDir = path.resolve(options.parking, options.to)
  if (holdersOf(number, [targetDir]).length > 0)
    return refused(ui => ui.lore.intakeMoveTargetHasNumber(number, targetDir))
  if (found.length > 1)
    return refused(ui => ui.lore.intakeMoveAmbiguous(number, found.join(', ')))
  const from = found[0]!
  const target = path.join(targetDir, path.basename(from))
  const text = readFileSync(from, 'utf8')
  const parsed = parseParkingFile(path.basename(from), text)
  if (parsed.kind === 'refused')
    return refused(ui => ui.lore.intakeRefusedUnreadable(`${from}: ${parsed.reason}`))
  mkdirSync(targetDir, { recursive: true })
  renameSync(from, target)
  mkdirSync(path.dirname(options.journal), { recursive: true })
  appendFileSync(options.journal, `${JSON.stringify({
    event: INTAKE_MOVE_EVENT,
    task: String(number),
    from: path.dirname(from),
    to: targetDir,
    bodySha: bodySha(text),
    ts: now().toISOString(),
  })}\n`)
  return { status: 'moved', from, to: target }
}

export function printMove(ui: Ui, result: MoveResult): number {
  if (result.status === 'refused') {
    ui.flatline(result.why(ui))
    return INTAKE_EXIT.refused
  }
  ui.ok(ui.lore.intakeMoved(result.from, result.to))
  return INTAKE_EXIT.admitted
}
