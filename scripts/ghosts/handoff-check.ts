import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'

export const PREFIX = '[handoff:check] '

export interface HandoffField {
  id: string
  label: string
  group: 'where we are' | 'what continuing needs' | 'how to verify' | 'what must not be lost'
}

export const HANDOFF_FIELDS: readonly HandoffField[] = [
  { id: 'current-card', label: 'current card', group: 'where we are' },
  { id: 'queue', label: 'queue', group: 'where we are' },
  { id: 'done', label: 'done', group: 'where we are' },
  { id: 'not-done', label: 'not done', group: 'where we are' },
  { id: 'journal', label: 'journal', group: 'what continuing needs' },
  { id: 'card-paths', label: 'card paths', group: 'what continuing needs' },
  { id: 'cloud-runs', label: 'cloud runs', group: 'what continuing needs' },
  { id: 'delegation', label: 'delegation', group: 'what continuing needs' },
  { id: 'local-decisions', label: 'local decisions', group: 'what continuing needs' },
  { id: 'judge-format', label: 'judge format', group: 'how to verify' },
  { id: 'gates', label: 'gates', group: 'how to verify' },
  { id: 'owner-waits', label: 'owner waits', group: 'how to verify' },
  { id: 'decisions', label: 'decisions', group: 'what must not be lost' },
  { id: 'intake-tokens', label: 'intake tokens', group: 'what must not be lost' },
  { id: 'probe-results', label: 'probe results', group: 'what must not be lost' },
  { id: 'stop-reason', label: 'stop reason', group: 'what must not be lost' },
  { id: 'continue-when', label: 'continue when', group: 'what must not be lost' },
]

const HEADING = /^#{1,6} +(\S.*)$/
const LIST_MARKERS = /^(?:(?:[-*+]|\d+[.)])\s+)+/
const PLACEHOLDER = /^(?:[\p{P}\p{S}\s]*|\s*(?:tbd|todo)\s*)$/iu

function normalised(label: string): string {
  return label.toLowerCase().replace(/[*_`]/g, '').trim().replace(LIST_MARKERS, '').replace(/:$/, '').trim()
}

function labelled(line: string): { label: string, value: string } | null {
  const colon = line.indexOf(':')
  if (colon < 0)
    return null
  const label = normalised(line.slice(0, colon))
  return { label, value: line.slice(colon + 1).trim() }
}

function valuesOf(text: string): Map<string, string> {
  const values = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  let heading: string | null = null
  const add = (label: string, value: string): void => {
    values.set(label, `${values.get(label) ?? ''}${value}`)
  }
  for (const line of lines) {
    const head = HEADING.exec(line)
    if (head !== null) {
      heading = normalised(head[1])
      add(heading, '')
      continue
    }
    const field = labelled(line)
    if (field !== null && HANDOFF_FIELDS.some(known => known.label === field.label)) {
      add(field.label, field.value)
      continue
    }
    if (heading !== null)
      add(heading, line.trim())
  }
  return values
}

export function missingFields(text: string): HandoffField[] {
  const values = valuesOf(text)
  return HANDOFF_FIELDS.filter(field => PLACEHOLDER.test(values.get(field.label) ?? ''))
}

export function refusal(missing: readonly HandoffField[]): string[] {
  return missing.map(field => `${PREFIX}missing: ${field.label} (${field.id}, ${field.group})`)
}

export const HANDOFF_LIMIT = 6000
export const OWNER_DECISIONS_LABEL = 'owner decisions'

export function handoffBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
export const PREV_LABEL = 'prev'
export const IN_FLIGHT_LABEL = 'in-flight'
export const NO_PREV = 'none'
export const IN_FLIGHT_FORMAT = '#N <stage> [PR #M]'

const STOP_HEADING = /^#{1,6} +STOP\b/
const ANY_LABEL = /^\s*(?:[-*+]\s+)?[a-z][\w -]{0,30}:/i
const SINGLE_LABELS = ['queue', IN_FLIGHT_LABEL, PREV_LABEL] as const
const ARCHIVED_PREV = /^archive\/\d{4,}\.md$/
export const RETIRED_PARKING = ['archive', 'dropped', 'sliced'] as const
const STATUS_LABEL = 'status'
const BLOCK_LABELS = new Set([...HANDOFF_FIELDS.map(field => field.label), PREV_LABEL, IN_FLIGHT_LABEL, STATUS_LABEL, OWNER_DECISIONS_LABEL])
const QUEUE_CARD = /#(\d+)/g
const QUEUE_CARD_TEXT = /#\d+/g
const QUEUE_SEPARATORS = /[\s,;→∥·|>-]+/g
const IN_FLIGHT_ENTRY = /^#\d+ (?!PR\b)\S+(?: PR ?#\d+)?$/
const NONE = /^none$/i

export type ParkedDepends = ReadonlyMap<number, readonly number[]>

export interface HandoffContext {
  file: string
  home: string
  exists: (file: string) => boolean
  parked: ParkedDepends
}

export type StopSections = 'exactly-one' | 'at-most-one'

interface Block {
  label: string
  lines: string[]
}

function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  for (const line of text.split(/\r?\n/)) {
    const head = HEADING.exec(line)
    const field = head === null ? labelled(line) : null
    if (head !== null)
      blocks.push({ label: normalised(head[1]), lines: [] })
    else if (field !== null && (BLOCK_LABELS.has(field.label) || ANY_LABEL.test(line)))
      blocks.push({ label: field.label, lines: field.value === '' ? [] : [field.value] })
    else if (line.trim() !== '' && blocks.length > 0)
      blocks.at(-1)!.lines.push(line.trim())
  }
  return blocks
}

function blockOf(blocks: readonly Block[], label: string): Block | undefined {
  return blocks.find(block => block.label === label)
}

function repeatedRefusals(blocks: readonly Block[]): string[] {
  return SINGLE_LABELS.flatMap((label) => {
    const count = blocks.filter(block => block.label === label).length
    return count > 1 ? [`${PREFIX}${label}: appears ${count} times; a handoff holds one`] : []
  })
}

function blockSize(block: Block): number {
  return handoffBytes(block.label) + handoffBytes(block.lines.join('\n'))
}

function stopRefusals(text: string, allowed: StopSections): string[] {
  const stops = text.split(/\r?\n/).filter(line => STOP_HEADING.test(line)).length
  return stops === 1 || (stops === 0 && allowed === 'at-most-one') ? [] : [`${PREFIX}STOP sections: ${stops}; a handoff holds exactly one, the older ones go to the archive through pnpm handoff:write`]
}

function sizeRefusals(text: string, blocks: readonly Block[]): string[] {
  const bytes = handoffBytes(text)
  if (bytes <= HANDOFF_LIMIT)
    return []
  const largest = [...blocks].sort((a, b) => blockSize(b) - blockSize(a))[0]
  const named = largest === undefined ? '' : `; largest field: ${largest.label} (${blockSize(largest)} bytes)`
  return [`${PREFIX}too large: ${bytes} bytes over the limit of ${HANDOFF_LIMIT}${named}`]
}

function queueRefusals(blocks: readonly Block[], parked: ParkedDepends | null): string[] {
  const queue = blockOf(blocks, 'queue')
  if (queue === undefined)
    return []
  const value = queue.lines.join(' ')
  const prose = value.replace(QUEUE_CARD_TEXT, ' ').replace(QUEUE_SEPARATORS, ' ').trim()
  const ids = [...value.matchAll(QUEUE_CARD)].map(match => Number(match[1]))
  if (prose !== '' && !(NONE.test(prose) && ids.length === 0))
    return [`${PREFIX}queue: prose "${prose.slice(0, 60)}"; queue takes only card numbers (#N), and their order comes from the cards' depends in parking`]
  if (parked === null)
    return []
  const refusals: string[] = []
  for (const [index, id] of ids.entries()) {
    const depends = parked.get(id)
    if (depends === undefined) {
      refusals.push(`${PREFIX}queue: #${id} is not a parked card`)
      continue
    }
    for (const later of depends.filter(dependency => ids.indexOf(dependency) > index))
      refusals.push(`${PREFIX}queue: #${id} depends on #${later}, which comes after it`)
  }
  return refusals
}

function prevRefusals(blocks: readonly Block[], context: HandoffContext): string[] {
  const prev = blockOf(blocks, PREV_LABEL)?.lines.join(' ').trim() ?? ''
  if (prev === '')
    return [`${PREFIX}missing: ${PREV_LABEL} (the archive the previous handoff went to, or ${NO_PREV}); pnpm handoff:write writes it`]
  if (prev === NO_PREV)
    return []
  if (!ARCHIVED_PREV.test(prev))
    return [`${PREFIX}${PREV_LABEL}: ${prev} is not archive/NNNN.md beside the handoff`]
  return context.exists(path.resolve(path.dirname(context.file), prev)) ? [] : [`${PREFIX}${PREV_LABEL}: ${prev} does not exist`]
}

export function decisionsPath(text: string, file: string, home: string): string | null {
  const value = valuesOf(text).get('decisions')?.trim() ?? ''
  if (PLACEHOLDER.test(value))
    return null
  if (value === '~' || value.startsWith('~/'))
    return path.join(home, value.slice(2))
  return path.resolve(path.dirname(file), value)
}

function decisionsRefusals(text: string, blocks: readonly Block[], context: HandoffContext): string[] {
  const refusals = blocks.some(block => block.label === OWNER_DECISIONS_LABEL)
    ? [`${PREFIX}${OWNER_DECISIONS_LABEL} as prose: move them to the decisions file`]
    : []
  const decisions = decisionsPath(text, context.file, context.home)
  return decisions === null || context.exists(decisions) ? refusals : [...refusals, `${PREFIX}decisions: ${decisions} does not exist`]
}

function inFlightRefusals(blocks: readonly Block[]): string[] {
  const inFlight = blockOf(blocks, IN_FLIGHT_LABEL)
  if (inFlight === undefined || inFlight.lines.length === 0)
    return [`${PREFIX}missing: ${IN_FLIGHT_LABEL} (one line per card, ${IN_FLIGHT_FORMAT}, or ${NO_PREV})`]
  const entries = inFlight.lines.map(line => line.replace(LIST_MARKERS, '').trim())
  if (entries.length === 1 && NONE.test(entries[0]!))
    return []
  return entries.filter(entry => !IN_FLIGHT_ENTRY.test(entry)).map(entry => `${PREFIX}${IN_FLIGHT_LABEL}: "${entry.slice(0, 60)}" is not ${IN_FLIGHT_FORMAT}`)
}

function boundRefusals(text: string, blocks: readonly Block[], stops: StopSections, parked: ParkedDepends | null): string[] {
  return [...refusal(missingFields(text)), ...stopRefusals(text, stops), ...sizeRefusals(text, blocks), ...repeatedRefusals(blocks), ...queueRefusals(blocks, parked)]
}

export function reportRefusals(text: string): string[] {
  return boundRefusals(text, blocksOf(text), 'at-most-one', null)
}

export function handoffRefusals(text: string, context: HandoffContext): string[] {
  const blocks = blocksOf(text)
  return [
    ...boundRefusals(text, blocks, 'exactly-one', context.parked),
    ...prevRefusals(blocks, context),
    ...decisionsRefusals(text, blocks, context),
    ...inFlightRefusals(blocks),
  ]
}

const PARKED_CARD = /^\d+\.md$/

export function parkedDepends(parking: string): Map<number, number[]> {
  const parked = new Map<number, number[]>()
  const visit = (dir: string, nested: boolean): void => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!nested && !(RETIRED_PARKING as readonly string[]).includes(entry.name))
          visit(file, true)
        continue
      }
      if (!PARKED_CARD.test(entry.name))
        continue
      const card = parseParkingFile(entry.name, readFileSync(file, 'utf8'))
      if (card.kind === 'parked' && !parked.has(Number(card.parked.task.id)))
        parked.set(Number(card.parked.task.id), card.parked.task.card.depends)
    }
  }
  visit(parking, false)
  return parked
}

export function defaultParking(home: string): string {
  return path.join(home, '.construct', 'parking')
}

export interface HandoffCheckDeps {
  exists: (file: string) => boolean
  read: (file: string) => string
  parked: (parking: string) => ParkedDepends
  home: string
  out: (line: string) => void
  err: (line: string) => void
}

export const USAGE = 'usage: handoff-check.ts <handoff file> [--parking <dir>]'

export function runHandoffCheck(args: string[], deps: HandoffCheckDeps): number {
  const [file, ...rest] = args
  const parking = rest.length === 2 && rest[0] === '--parking' ? rest[1] : rest.length === 0 ? defaultParking(deps.home) : undefined
  if (file === undefined || file.startsWith('--') || parking === undefined) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no handoff at ${file}`)
    return 1
  }
  const refusals = handoffRefusals(deps.read(file), { file, home: deps.home, exists: deps.exists, parked: deps.parked(parking) })
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${file} is not a handoff: ${refusals.length} refusals`)
    return 1
  }
  deps.out(`${PREFIX}${file}: all ${HANDOFF_FIELDS.length} fields present, one STOP section, within ${HANDOFF_LIMIT} bytes`)
  return 0
}

const isEntry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isEntry) {
  process.exitCode = runHandoffCheck(process.argv.slice(2), {
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    parked: parkedDepends,
    home: os.homedir(),
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  })
}
