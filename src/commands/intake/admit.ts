import type { Card } from '../../card/grammar.js'
import type { ParkedTask } from '../../card/parking.js'
import type { Ui } from '../../ui/console.js'
import type { CheckedCard } from './check.js'
import type { DraftCard } from './draft.js'
import type { SlicedCard } from './slice.js'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { closedTasks } from '../../card/closed.js'
import { cardLine, parseCard } from '../../card/grammar.js'
import { parseParkingFile } from '../../card/parking.js'
import { CARD_REFERENCE, checkDraft, correctionText } from './check.js'
import { confirmationOf, confirmationToken, INTAKE_EVENT, intakeJournalLine } from './confirm.js'
import { DirectoryFacts } from './facts.js'
import { INTAKE_EXIT } from './index.js'
import { parkedNumbers } from './numbers.js'
import { CORRECTED_PREFIX, UNCLEAR_PREFIX, WITNESSES_HEADING } from './slice.js'

const WITNESS_ITEM = /^- (.+)$/
const BLOCKS_SEPARATOR = ' · blocks '
const LEADING_BLOCKS = /^(?:—|#\d+(?:,? #\d+)*)/
const CARD_HEADER = 'card: '
const TOUCHES_HEADER = 'touches: '
export const ADMIT_SOURCE = 'admit'

export interface AdmitOptions {
  file: string
  dir?: string
  journal: string
  dryRun: boolean
  confirm?: string
  autoConfirm: boolean
}

export type AdmitResult
  = | { status: 'refused', why: string }
    | { status: 'admitted' | 'alreadyAdmitted' | 'dryRun', file: string, card: SlicedCard, autoConfirm: boolean }
    | { status: 'awaiting', file: string, card: SlicedCard, token: string, stale: boolean }

function witnessesOf(body: string): string[] {
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
    creates: [],
    task: body,
    witnesses: witnessesOf(body),
    unclear: [],
  }
}

function ids(references: readonly string[]): number[] {
  return references.map(reference => Number(CARD_REFERENCE.exec(reference)![1]))
}

function blocksTail(line: string): string {
  const blocks = line.split(BLOCKS_SEPARATOR)[1] ?? ''
  return blocks.replace(LEADING_BLOCKS, '')
}

function admittedLine(card: Card, checked: CheckedCard): string {
  const depends = ids(checked.depends)
  const blocks = ids(checked.blocks)
  if (depends.length === card.depends.length && blocks.length === card.blocks.length)
    return card.line
  return `${cardLine({ ...card, depends, blocks })}${blocksTail(card.line)}`
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

function admittedBefore(journal: string | null, card: Card, line: string): boolean {
  const parsed = parseCard(line)
  const wanted = parsed.kind === 'card' ? cardLine(parsed.card) : line
  return (journal ?? '').split('\n').some((text) => {
    try {
      const entry = JSON.parse(text) as Record<string, unknown> | null
      if (entry?.event !== INTAKE_EVENT || entry.task !== String(card.id) || typeof entry.card !== 'string')
        return false
      const recorded = parseCard(entry.card)
      return recorded.kind === 'card' && cardLine(recorded.card) === wanted
    }
    catch {
      return false
    }
  })
}

function siblings(file: string): string[] {
  const parking = path.dirname(file)
  return existsSync(parking) ? readdirSync(parking) : []
}

export function runAdmit(options: AdmitOptions, now: () => Date = () => new Date()): AdmitResult {
  let text: string
  let journal: string | null
  try {
    text = readFileSync(options.file, 'utf8')
    journal = existsSync(options.journal) ? readFileSync(options.journal, 'utf8') : null
  }
  catch (error) {
    return { status: 'refused', why: error instanceof Error ? error.message : String(error) }
  }
  const file = path.basename(options.file)
  const parsed = parseParkingFile(file, text)
  if (parsed.kind === 'refused')
    return { status: 'refused', why: parsed.reason }
  const { card } = parsed.parked.task
  const [checked] = checkDraft([draftOf(parsed.parked)], [card.id], {
    taken: new Set(),
    parked: new Set(parkedNumbers(siblings(options.file))),
    closed: new Set(closedTasks(journal).keys()),
    repository: options.dir === undefined ? null : new DirectoryFacts(options.dir, process.env.PATH ?? ''),
  }) as [CheckedCard]
  const line = admittedLine(card, checked)
  const admitted: SlicedCard = {
    id: card.id,
    file,
    line,
    who: parsed.parked.who,
    seam: [],
    unclear: checked.unclear,
    corrections: checked.corrections,
    text: admittedText(text, line, checked),
  }
  const base = { file: options.file, card: admitted, autoConfirm: options.autoConfirm }
  if (admittedBefore(journal, card, line))
    return { ...base, status: 'alreadyAdmitted' }
  const reparsed = parseParkingFile(file, admitted.text)
  if (reparsed.kind === 'refused')
    return { status: 'refused', why: reparsed.reason }
  if (options.dryRun)
    return { ...base, status: 'dryRun' }
  const token = confirmationToken([admitted])
  if (!options.autoConfirm && admitted.corrections.length > 0 && options.confirm !== token)
    return { status: 'awaiting', file: options.file, card: admitted, token, stale: options.confirm !== undefined }
  if (admitted.text !== text)
    writeFileSync(options.file, admitted.text)
  mkdirSync(path.dirname(options.journal), { recursive: true })
  appendFileSync(options.journal, `${intakeJournalLine(admitted, confirmationOf(admitted, options.autoConfirm), now(), ADMIT_SOURCE)}\n`)
  return { ...base, status: 'admitted' }
}

export function printAdmit(ui: Ui, result: AdmitResult): number {
  if (result.status === 'refused') {
    ui.flatline(ui.lore.intakeRefusedUnreadable(result.why))
    return INTAKE_EXIT.refused
  }
  const { card } = result
  if (result.status === 'alreadyAdmitted') {
    ui.ok(ui.lore.intakeAlreadyAdmitted(result.file, card.line))
    return INTAKE_EXIT.alreadyAdmitted
  }
  if (result.status === 'awaiting' && result.stale)
    ui.flatline(ui.lore.intakeConfirmStale)
  if (result.status === 'dryRun')
    ui.line(card.text)
  else if (result.status === 'awaiting')
    ui.line(ui.lore.intakeAwaitingCard(card.line))
  else
    ui.ok(ui.lore.intakeAdmitted(result.file, card.line))
  if (result.status !== 'dryRun') {
    for (const correction of card.corrections)
      ui.line(ui.theme.dim(`  ${ui.lore.intakeCorrected(correctionText(correction))}`))
  }
  if (card.corrections.length > 0 && result.status === 'admitted')
    ui.line(ui.theme.dim(`  ${ui.lore.intakeConfirmed(card.corrections.length, result.autoConfirm)}`))
  if (card.unclear.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.intakeAdmitUnclear(card.unclear.length)}`))
  if (result.status === 'dryRun')
    ui.line(ui.lore.intakeAdmitDryRun(result.file))
  if (result.status === 'awaiting')
    ui.line(ui.lore.intakeAdmitAwaiting(result.file, result.token))
  return INTAKE_EXIT[result.status]
}
