import type { AdmitOptions, AdmitResult } from './admit.js'
import type { CardAdmissionsPort } from './index.js'
import { SHIFT_WHO, WINDOW_WHO } from '../../card/parking.js'
import { admittedCardFile, runAdmit, witnessesOf } from './admit.js'
import { TOUCHES_HEADER } from './confirm.js'
import { exportRefusalReason, runExport } from './export.js'
import { CARD_NUMBER } from './move.js'

export interface AmendFlags {
  touches?: string
  creates?: string
  note?: string
  witness?: string
  who?: string
}

export interface AmendOptions extends Omit<AdmitOptions, 'file' | 'body' | 'admissions'> {
  card: string
  flags: AmendFlags
  admissions: CardAdmissionsPort | undefined
}

type Edited = { kind: 'edited', text: string } | { kind: 'refused', why: string }

const CREATES_HEADER = 'creates: '
const WHO_HEADER = 'who: '
const LIST_SEPARATOR = ','
const ADD = '+'
const REMOVE = '-'
const WITNESS_ITEM_PREFIX = '- '
const WHO_VALUES: readonly string[] = [SHIFT_WHO, WINDOW_WHO]

function refused(why: string): Edited {
  return { kind: 'refused', why }
}

function headerEnd(lines: readonly string[]): number {
  const blank = lines.findIndex(line => line.trim() === '')
  return blank === -1 ? lines.length : blank
}

function headerIndex(lines: readonly string[], header: string): number {
  return lines.slice(0, headerEnd(lines)).findIndex(line => line.startsWith(header) || line === header.trim())
}

function listOf(line: string | undefined, header: string): string[] {
  return line === undefined ? [] : line.slice(header.length).split(LIST_SEPARATOR).map(entry => entry.trim()).filter(entry => entry !== '')
}

function editedList(current: readonly string[], change: string, flag: string): string[] | string {
  let next = [...current]
  for (const entry of change.split(LIST_SEPARATOR).map(item => item.trim()).filter(item => item !== '')) {
    const sign = entry[0]
    const value = entry.slice(1).trim()
    if ((sign !== ADD && sign !== REMOVE) || value === '')
      return `--${flag} ${entry} is +<path> or -<path>`
    if (sign === ADD && !next.includes(value))
      next.push(value)
    if (sign === REMOVE) {
      if (!next.includes(value))
        return `--${flag} ${entry}: the card's ${flag} name no ${value}`
      next = next.filter(item => item !== value)
    }
  }
  return next
}

function withList(lines: string[], header: string, change: string, flag: string, required: boolean): string[] | string {
  const at = headerIndex(lines, header)
  const next = editedList(listOf(at === -1 ? undefined : lines[at], header), change, flag)
  if (typeof next === 'string')
    return next
  if (next.length === 0 && required)
    return `--${flag} ${change} leaves the card no ${flag}`
  const line = `${header}${next.join(', ')}`
  if (at !== -1)
    return next.length === 0 ? lines.filter((_, index) => index !== at) : lines.map((entry, index) => (index === at ? line : entry))
  if (next.length === 0)
    return lines
  const after = headerIndex(lines, TOUCHES_HEADER)
  const insertAt = after === -1 ? headerEnd(lines) : after + 1
  return [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)]
}

function withWho(lines: string[], who: string): string[] | string {
  if (!WHO_VALUES.includes(who))
    return `--who ${who} is one of ${WHO_VALUES.join(', ')}`
  const at = headerIndex(lines, WHO_HEADER)
  return at === -1 ? `the card has no ${WHO_HEADER.trim()} line` : lines.map((entry, index) => (index === at ? `${WHO_HEADER}${who}` : entry))
}

function witnessSplit(change: string, witnesses: readonly string[]): [string, string] | null {
  for (let at = change.indexOf('='); at !== -1; at = change.indexOf('=', at + 1)) {
    const old = change.slice(0, at).trim()
    if (witnesses.includes(old))
      return [old, change.slice(at + 1).trim()]
  }
  return null
}

function withWitness(lines: string[], change: string): string[] | string {
  const split = witnessSplit(change, witnessesOf(lines.join('\n')))
  if (split === null)
    return `--witness ${change}: no witness of the card stands left of an =; give <old witness>=<new witness>`
  const [old, next] = split
  if (next === '')
    return `--witness ${change} gives no new witness`
  const at = lines.findIndex(line => line.trim() === `${WITNESS_ITEM_PREFIX}${old}`)
  return lines.map((entry, index) => (index === at ? `${WITNESS_ITEM_PREFIX}${next}` : entry))
}

function withNote(lines: string[], note: string): string[] {
  const body = [...lines]
  while (body.length > 0 && body.at(-1)!.trim() === '')
    body.pop()
  return [...body, '', note.trim(), '']
}

type Edit = (lines: string[]) => string[] | string

function editsOf(flags: AmendFlags): Edit[] {
  const edits: Edit[] = []
  if (flags.touches !== undefined)
    edits.push(lines => withList(lines, TOUCHES_HEADER, flags.touches!, 'touches', true))
  if (flags.creates !== undefined)
    edits.push(lines => withList(lines, CREATES_HEADER, flags.creates!, 'creates', false))
  if (flags.who !== undefined)
    edits.push(lines => withWho(lines, flags.who!))
  if (flags.witness !== undefined)
    edits.push(lines => withWitness(lines, flags.witness!))
  if (flags.note !== undefined && flags.note.trim() !== '')
    edits.push(lines => withNote(lines, flags.note!))
  return edits
}

export function amendedText(text: string, flags: AmendFlags): Edited {
  const edits = editsOf(flags)
  if (edits.length === 0)
    return refused('--amend takes at least one of --touches, --creates, --note, --witness, --who')
  let lines = text.split('\n')
  for (const edit of edits) {
    const next = edit(lines)
    if (typeof next === 'string')
      return refused(next)
    lines = next
  }
  return { kind: 'edited', text: lines.join('\n') }
}

export function runAmend(options: AmendOptions, now: () => Date = () => new Date()): AdmitResult {
  const { card, flags, admissions, ...admit } = options
  const exported = runExport({ card, admissions: admissions ?? (() => null) })
  if (exported.status === 'refused')
    return { status: 'refused', why: exportRefusalReason(exported) }
  const id = Number(CARD_NUMBER.exec(card)![1])
  const edited = amendedText(exported.text, flags)
  if (edited.kind === 'refused')
    return { status: 'refused', why: `#${id}: ${edited.why}` }
  const result = runAdmit({ ...admit, file: admittedCardFile(id, admit.parkingRoot), body: edited.text, admissions }, now)
  return 'file' in result ? { ...result, file: `#${id}` } : result
}
