import type { WitnessField } from '../../card/witness-fields.js'
import type { AdmitOptions, AdmitResult } from './admit.js'
import type { CardAdmissionsPort } from './index.js'
import process from 'node:process'
import { cardLine, parseCard } from '../../card/grammar.js'
import { PRIORITIES, SHIFT_WHO, WINDOW_WHO } from '../../card/parking.js'
import { RISK_PREFIX, riskLines, riskReading } from '../../card/risk.js'
import { parseWitnessList, replaceWitnessFieldsLine, runsFieldOf, witnessFieldsOf } from '../../card/witness-fields.js'
import { admittedCardFile, blocksTail, CARD_HEADER, runAdmit, withRunsLine, witnessesOf } from './admit.js'
import { CARD_REFERENCE } from './check.js'
import { TOUCHES_HEADER } from './confirm.js'
import { exportRefusalReason, runExport } from './export.js'
import { DirectoryFacts } from './facts.js'
import { CARD_NUMBER } from './move.js'
import { WITNESSES_HEADING } from './slice.js'

export interface AmendFlags {
  touches?: string
  creates?: string
  note?: string
  witness?: string
  who?: string
  addWitnesses?: readonly string[]
  removeWitnesses?: readonly string[]
  ownerWords?: string
  depends?: string
  priority?: string
}

export interface AmendOptions extends Omit<AdmitOptions, 'file' | 'body' | 'admissions'> {
  card: string
  flags: AmendFlags
  admissions: CardAdmissionsPort | undefined
}

type Edited = { kind: 'edited', text: string } | { kind: 'refused', why: string }

const CREATES_HEADER = 'creates: '
const WHO_HEADER = 'who: '
const PRIORITY_HEADER = 'priority: '
export const NO_PRIORITY = 'none'
const PRIORITY_VALUES: readonly string[] = [...PRIORITIES, NO_PRIORITY]
const LIST_SEPARATOR = ','
const LIST_ENTRY_SEPARATOR = /,|\s+(?=[+-])/
const PROSE_WITNESS_ID = /^W([1-9]\d*)$/
const OWNER_WORDS_PREFIX = 'Owner, verbatim: '
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
  for (const entry of change.split(LIST_ENTRY_SEPARATOR).map(item => item.trim()).filter(item => item !== '')) {
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

function withPriority(lines: string[], priority: string): string[] | string {
  if (!PRIORITY_VALUES.includes(priority))
    return `--priority ${priority} is one of ${PRIORITY_VALUES.join(', ')}`
  const at = headerIndex(lines, PRIORITY_HEADER)
  if (priority === NO_PRIORITY)
    return at === -1 ? lines : lines.filter((_, index) => index !== at)
  const line = `${PRIORITY_HEADER}${priority}`
  if (at !== -1)
    return lines.map((entry, index) => (index === at ? line : entry))
  const end = headerEnd(lines)
  return [...lines.slice(0, end), line, ...lines.slice(end)]
}

function witnessSplit(change: string, witnesses: readonly string[]): [string, string] | null {
  for (let at = change.indexOf('='); at !== -1; at = change.indexOf('=', at + 1)) {
    const old = change.slice(0, at).trim()
    if (witnesses.includes(old))
      return [old, change.slice(at + 1).trim()]
  }
  return null
}

function withWitnessField(lines: string[], fields: readonly WitnessField[], change: string): string[] | string {
  const at = change.indexOf('=')
  const id = change.slice(0, Math.max(at, 0)).trim()
  if (!fields.some(field => field.id === id))
    return `--witness ${change}: the card's witnesses are fields; give <id>=<the witness field as JSON>, the id one of ${fields.map(field => field.id).join(', ')}`
  let next: unknown
  try {
    next = JSON.parse(change.slice(at + 1))
  }
  catch (error) {
    return `--witness ${change}: the new witness field is not JSON: ${error instanceof Error ? error.message : String(error)}`
  }
  return replaceWitnessFieldsLine(lines, fields.map(field => field.id === id ? next : field))
}

function withWitness(lines: string[], change: string): string[] | string {
  const fields = witnessFieldsOf(lines.join('\n'))
  if (fields !== null)
    return withWitnessField(lines, fields, change)
  const split = witnessSplit(change, witnessesOf(lines.join('\n')))
  if (split === null)
    return `--witness ${change}: no witness of the card stands left of an =; give <old witness>=<new witness>`
  const [old, next] = split
  if (next === '')
    return `--witness ${change} gives no new witness`
  const at = lines.findIndex(line => line.trim() === `${WITNESS_ITEM_PREFIX}${old}`)
  return lines.map((entry, index) => (index === at ? `${WITNESS_ITEM_PREFIX}${next}` : entry))
}

function withAddedWitnessField(lines: string[], fields: readonly WitnessField[], witness: string): string[] | string {
  let next: unknown
  try {
    next = JSON.parse(witness)
  }
  catch (error) {
    return `--add-witness ${witness}: the card's witnesses are fields and this is not JSON: ${error instanceof Error ? error.message : String(error)}`
  }
  const parsed = parseWitnessList([next])
  if (parsed.kind === 'refused')
    return `--add-witness ${witness}: ${parsed.reasons.join('; ')}`
  const id = parsed.fields[0]!.id
  return fields.some(field => field.id === id) ? `--add-witness ${witness}: the card already holds a witness ${id}` : replaceWitnessFieldsLine(lines, [...fields, next])
}

function witnessesAt(lines: readonly string[]): number {
  return lines.findIndex(line => line.trim() === WITNESSES_HEADING) + 1
}

function withAddedWitness(lines: string[], witness: string): string[] | string {
  const text = lines.join('\n')
  const fields = witnessFieldsOf(text)
  if (fields !== null)
    return withAddedWitnessField(lines, fields, witness)
  const first = witnessesAt(lines)
  if (first === 0)
    return `--add-witness ${witness}: the card has no ${WITNESSES_HEADING} list`
  const held = witnessesOf(text)
  if (held.includes(witness))
    return `--add-witness ${witness}: the card already holds this witness`
  const insertAt = first + held.length
  return [...lines.slice(0, insertAt), `${WITNESS_ITEM_PREFIX}${witness}`, ...lines.slice(insertAt)]
}

function proseWitnessIndex(witnesses: readonly string[], named: string): number {
  const numbered = PROSE_WITNESS_ID.exec(named)?.[1]
  return numbered === undefined ? witnesses.indexOf(named) : Number(numbered) - 1
}

function withRemovedWitness(lines: string[], named: string): string[] | string {
  const text = lines.join('\n')
  const fields = witnessFieldsOf(text)
  const held = fields === null ? witnessesOf(text) : fields.map(field => field.id)
  const index = fields === null ? proseWitnessIndex(held, named) : held.indexOf(named)
  if (held[index] === undefined)
    return `--remove-witness ${named}: the card holds no such witness`
  if (held.length === 1)
    return `--remove-witness ${named} leaves the card no witness`
  if (fields !== null)
    return replaceWitnessFieldsLine(lines, fields.filter(field => field.id !== named))
  const at = witnessesAt(lines) + index
  return lines.filter((_, line) => line !== at)
}

function withDepends(lines: string[], change: string): string[] | string {
  const at = headerIndex(lines, CARD_HEADER)
  const parsed = parseCard(lines[at]?.slice(CARD_HEADER.length) ?? '')
  if (parsed.kind === 'refused')
    return `--depends ${change}: ${parsed.reason}`
  const next = editedList(parsed.card.depends.map(id => `#${id}`), change, 'depends')
  if (typeof next === 'string')
    return next
  const malformed = next.find(reference => !CARD_REFERENCE.test(reference))
  if (malformed !== undefined)
    return `--depends ${change}: ${malformed} is not a card, #<id>`
  const depends = next.map(reference => Number(CARD_REFERENCE.exec(reference)![1]))
  return lines.map((entry, index) => (index === at ? `${CARD_HEADER}${cardLine({ ...parsed.card, depends })}${blocksTail(parsed.card.line)}` : entry))
}

function withNote(lines: string[], note: string): string[] {
  const body = [...lines]
  while (body.length > 0 && body.at(-1)!.trim() === '')
    body.pop()
  return [...body, '', note.trim(), '']
}

function withRecomputedRisk(lines: string[]): string[] {
  const at = lines.map(line => line.startsWith(RISK_PREFIX)).lastIndexOf(true)
  if (at === -1)
    return lines
  const reading = riskReading(listOf(lines[headerIndex(lines, TOUCHES_HEADER)], TOUCHES_HEADER), false)
  const [line] = riskLines({ ...reading, slices: [], capabilityDelivery: false })
  return lines.map((entry, index) => (index === at ? line! : entry))
}

type Edit = (lines: string[]) => string[] | string

function fieldEditsOf(flags: AmendFlags): Edit[] {
  const edits: Edit[] = []
  if (flags.touches !== undefined)
    edits.push(lines => withList(lines, TOUCHES_HEADER, flags.touches!, 'touches', true))
  if (flags.creates !== undefined)
    edits.push(lines => withList(lines, CREATES_HEADER, flags.creates!, 'creates', false))
  if (flags.who !== undefined)
    edits.push(lines => withWho(lines, flags.who!))
  if (flags.witness !== undefined)
    edits.push(lines => withWitness(lines, flags.witness!))
  for (const witness of flags.addWitnesses ?? [])
    edits.push(lines => withAddedWitness(lines, witness))
  for (const named of flags.removeWitnesses ?? [])
    edits.push(lines => withRemovedWitness(lines, named))
  if (flags.depends !== undefined)
    edits.push(lines => withDepends(lines, flags.depends!))
  return edits
}

function noteEditsOf(flags: AmendFlags): Edit[] {
  const edits: Edit[] = []
  if (flags.note !== undefined && flags.note.trim() !== '')
    edits.push(lines => withNote(lines, flags.note!))
  if (flags.ownerWords !== undefined && flags.ownerWords.trim() !== '')
    edits.push(lines => withNote(lines, `${OWNER_WORDS_PREFIX}"${flags.ownerWords!}"`))
  return edits
}

function priorityEditsOf(flags: AmendFlags): Edit[] {
  return flags.priority === undefined ? [] : [lines => withPriority(lines, flags.priority!.trim())]
}

function editsOf(flags: AmendFlags): Edit[] {
  const fields = fieldEditsOf(flags)
  const notes = noteEditsOf(flags)
  const priority = priorityEditsOf(flags)
  if (fields.length + notes.length === 0)
    return priority
  return [...fields, ...priority, withRecomputedRisk, ...notes]
}

export function listFlagOf(rawArgs: readonly string[], flag: string, separator: string = LIST_SEPARATOR): string | undefined {
  const values: string[] = []
  let found = false
  rawArgs.forEach((argument, at) => {
    if (argument.startsWith(`--${flag}=`)) {
      found = true
      values.push(argument.slice(flag.length + 3))
    }
    if (argument !== `--${flag}`)
      return
    found = true
    const next = rawArgs.slice(at + 1)
    const end = next.findIndex(value => value.startsWith('--'))
    values.push(...(end === -1 ? next : next.slice(0, end)))
  })
  return found ? values.join(separator) : undefined
}

export function amendedText(text: string, flags: AmendFlags): Edited {
  const edits = editsOf(flags)
  if (edits.length === 0)
    return refused('an amend takes at least one of --touches, --creates, --note, --witness, --who, --add-witness, --remove-witness, --owner-words, --depends, --priority')
  let lines = text.split('\n')
  for (const edit of edits) {
    const next = edit(lines)
    if (typeof next === 'string')
      return refused(next)
    lines = next
  }
  return { kind: 'edited', text: lines.join('\n') }
}

function touchesIn(text: string): string[] {
  const lines = text.split('\n')
  return listOf(lines[headerIndex(lines, TOUCHES_HEADER)], TOUCHES_HEADER)
}

function withoutStaleRuns(before: string, after: string, dir: string): string {
  const repository = new DirectoryFacts(dir, process.env.PATH ?? '')
  const covering = repository.testsCovering(touchesIn(after))
  const stale = repository.testsCovering(touchesIn(before)).filter(test => !covering.includes(test))
  return withRunsLine(after, runsFieldOf(after).filter(entry => !stale.includes(entry)))
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
  const body = flags.touches === undefined ? edited.text : withoutStaleRuns(exported.text, edited.text, admit.dir)
  const result = runAdmit({ ...admit, file: admittedCardFile(id, admit.parkingRoot), body, writeRuns: flags.touches !== undefined, priorityEdited: flags.priority !== undefined, admissions }, now)
  return 'file' in result ? { ...result, file: `#${id}` } : result
}
