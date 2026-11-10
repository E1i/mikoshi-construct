import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { FACTORY_RUNTIME } from '../../scripts/core/factory-paths.js'
import { touchError } from './task-file.js'

export const WITNESS_KINDS = ['acceptance', 'invariant'] as const
export type WitnessKind = typeof WITNESS_KINDS[number]

export type WitnessExpectation = 'pass' | 'fail' | `exit:${number}`

export interface WitnessField {
  id: string
  run: string
  test: string | null
  head: WitnessExpectation
  base: WitnessExpectation
  proves: string
}

export interface RenderedWitness {
  id: string
  command: string
  head: WitnessExpectation
  base: WitnessExpectation
}

export type ParsedWitnessList = { kind: 'fields', fields: WitnessField[] } | { kind: 'refused', reasons: string[] }

const WITNESSES_FIELD = 'witnesses: '
const RUNS_FIELD = 'runs: '
const LAYER_ENTRY_PREFIX = 'layer:'
const LAYER_MAP = FACTORY_RUNTIME.layerMap
const LAYER_MAP_ROOTS = [import.meta.dirname, path.resolve(import.meta.dirname, '..', '..')]
const LIST_OPENING = '['
const FIELD_KEYS = ['id', 'run', 'test', 'head', 'base', 'proves']
const WITNESS_ID = /^W[1-9]\d*$/
const EXPECTATION = /^(?:pass|fail|exit:(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5]))$/
const VITEST = /\bvitest\b/
const NAMES_A_TEST = /\s(?:-t|--testNamePattern)(?:=|\s)/
const NEGATION = /^!\s+/
const BACKTICK = '`'
const LINE_BREAK = /[\r\n]/
const SINGLE_QUOTE = '\''
const EXIT_PREFIX = 'exit:'
const KIND_SEPARATOR = ' · '
const RENDERED = /^(W[1-9]\d*): `([^`]+)` · head (\S+) · base (\S+) · (?:acceptance|invariant)$/
const JUDGED_WRAP = /^(?:\( ([\s\S]*)\n\); test \$\? -eq \d+|! \( ([\s\S]*)\n\))$/

export function withWitnessKind(witness: string, kind: WitnessKind): string {
  return `${witness.trim()}${KIND_SEPARATOR}${kind}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function runRefusals(at: string, entry: Record<string, unknown>): string[] {
  const { run, test } = entry
  if (!isText(run))
    return [`${at} has no run: a field witness is run by a command, and prose has no way in`]
  const reasons: string[] = []
  if (run.includes(BACKTICK) || LINE_BREAK.test(run))
    reasons.push(`${at}: its run is one line with no backtick; use $(…) for a substitution`)
  if (isText(test) && NAMES_A_TEST.test(` ${run}`))
    reasons.push(`${at}: the test name goes in 'test' or in the run's own -t, not both`)
  if (isText(test) && !VITEST.test(run))
    reasons.push(`${at}: 'test' is the name for vitest -t, and this run is no vitest run`)
  return reasons
}

function testRefusals(at: string, test: unknown): string[] {
  if (test === undefined || test === null)
    return []
  if (!isText(test) || test.includes(SINGLE_QUOTE) || test.includes(BACKTICK) || LINE_BREAK.test(test))
    return [`${at}: 'test' is a name for -t on one line with no single quote and no backtick, or null`]
  return []
}

function expectationRefusals(at: string, entry: Record<string, unknown>): string[] {
  const reasons = (['head', 'base'] as const).flatMap(key => typeof entry[key] === 'string' && EXPECTATION.test(entry[key]) ? [] : [`${at}: '${key}' is pass, fail or exit:N with N from 1 to 255, not ${JSON.stringify(entry[key])}`])
  const negatedWithExit = isText(entry.run) && NEGATION.test(entry.run.trim()) && [entry.head, entry.base].some(value => typeof value === 'string' && value.startsWith(EXIT_PREFIX))
  return negatedWithExit ? [...reasons, `${at}: a negated run exits 0 or 1 only; drop the ! or expect pass or fail`] : reasons
}

function fieldRefusals(entry: unknown, index: number): string[] {
  const at = `witness field ${index + 1}`
  if (!isRecord(entry))
    return [`${at} is not an object`]
  return [
    ...Object.keys(entry).filter(key => !FIELD_KEYS.includes(key)).map(key => `${at}: unknown key '${key}'; the keys are ${FIELD_KEYS.join(', ')}`),
    ...(typeof entry.id === 'string' && WITNESS_ID.test(entry.id) ? [] : [`${at}: 'id' is W1, W2, …`]),
    ...runRefusals(at, entry),
    ...testRefusals(at, entry.test),
    ...expectationRefusals(at, entry),
    ...(isText(entry.proves) ? [] : [`${at}: 'proves' says what the witness proves`]),
  ]
}

function repeatedIds(entries: readonly unknown[]): string[] {
  const ids = entries.flatMap(entry => isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : [])
  return [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))].map(id => `witness id ${id} is given to more than one field`)
}

export function parseWitnessList(value: unknown): ParsedWitnessList {
  if (!Array.isArray(value) || value.length === 0)
    return { kind: 'refused', reasons: ['the witness fields are a list with at least one witness'] }
  const reasons = [...value.flatMap(fieldRefusals), ...repeatedIds(value)]
  if (reasons.length > 0)
    return { kind: 'refused', reasons }
  return { kind: 'fields', fields: value.map((entry: WitnessField) => ({ ...entry, run: entry.run.trim(), test: entry.test ?? null })) }
}

function fieldLines(text: string, prefix: string): string[] {
  return text.split('\n').filter(line => line.startsWith(`${prefix}${LIST_OPENING}`)).map(line => line.slice(prefix.length))
}

export function isWitnessFieldLine(line: string): boolean {
  return [WITNESSES_FIELD, RUNS_FIELD].some(prefix => line.startsWith(`${prefix}${LIST_OPENING}`))
}

function listOfJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  }
  catch {
    return null
  }
}

export function isLayerEntry(entry: string): boolean {
  return entry.startsWith(LAYER_ENTRY_PREFIX)
}

export function layerNamedBy(entry: string): string {
  return entry.slice(LAYER_ENTRY_PREFIX.length)
}

export function layerEntryRefusals(entries: readonly string[], roots: readonly string[] = LAYER_MAP_ROOTS): string[] {
  if (entries.length === 0)
    return []
  const root = roots.find(candidate => existsSync(path.join(candidate, LAYER_MAP)))
  if (root === undefined)
    return [`runs entries ${entries.join(', ')} cannot be checked: this build holds no ${LAYER_MAP}`]
  const { files, folders } = JSON.parse(readFileSync(path.join(root, LAYER_MAP), 'utf8')) as Record<'files' | 'folders', Record<string, string>>
  const known = new Set([...Object.values(files), ...Object.values(folders)])
  return entries.filter(entry => !known.has(layerNamedBy(entry))).map(entry => `runs entry '${entry}' names no layer of ${LAYER_MAP}`)
}

function runsRefusals(text: string): string[] {
  return fieldLines(text, RUNS_FIELD).flatMap((json) => {
    const runs = listOfJson(json)
    if (!Array.isArray(runs) || !runs.every(isText))
      return [`'${RUNS_FIELD.trim()}' is a JSON list of paths, trailing /** globs and ${LAYER_ENTRY_PREFIX}<id> entries`]
    return [...runs.filter(entry => !isLayerEntry(entry)).flatMap(entry => touchError(entry) ?? []), ...layerEntryRefusals(runs.filter(isLayerEntry))]
  })
}

export function witnessFieldRefusals(text: string): string[] {
  const lines = fieldLines(text, WITNESSES_FIELD)
  const repeated = [...(lines.length > 1 ? [`'${WITNESSES_FIELD.trim()}' appears twice`] : []), ...(fieldLines(text, RUNS_FIELD).length > 1 ? [`'${RUNS_FIELD.trim()}' appears twice`] : [])]
  const parsed = lines.length === 1 ? parseWitnessList(listOfJson(lines[0]!)) : null
  return [...repeated, ...(parsed?.kind === 'refused' ? parsed.reasons : []), ...runsRefusals(text)]
}

export function witnessFieldsOf(text: string): WitnessField[] | null {
  const lines = fieldLines(text, WITNESSES_FIELD)
  if (lines.length !== 1)
    return null
  const parsed = parseWitnessList(listOfJson(lines[0]!))
  return parsed.kind === 'fields' ? parsed.fields : null
}

export function runsFieldOf(text: string): string[] {
  return fieldLines(text, RUNS_FIELD).flatMap((json) => {
    const runs = listOfJson(json)
    return Array.isArray(runs) ? runs.filter(isText) : []
  })
}

export function witnessFieldsLine(fields: readonly unknown[]): string {
  return `${WITNESSES_FIELD}${JSON.stringify(fields)}`
}

export function replaceWitnessFieldsLine(lines: readonly string[], fields: readonly unknown[]): string[] {
  return lines.map(line => line.startsWith(`${WITNESSES_FIELD}${LIST_OPENING}`) ? witnessFieldsLine(fields) : line)
}

export function runsFieldLine(runs: readonly string[]): string {
  return `${RUNS_FIELD}${JSON.stringify(runs)}`
}

export function fieldCommand(field: Pick<WitnessField, 'run' | 'test'>): string {
  return field.test === null ? field.run : `${field.run} -t '${field.test}'`
}

export function isAcceptanceField(field: Pick<WitnessField, 'head' | 'base'>): boolean {
  return field.head !== field.base
}

export function witnessText(field: WitnessField): string {
  const kind: WitnessKind = isAcceptanceField(field) ? 'acceptance' : 'invariant'
  return withWitnessKind(`${field.id}: \`${fieldCommand(field)}\` · head ${field.head} · base ${field.base}`, kind)
}

export function renderedWitness(text: string): RenderedWitness | null {
  const found = RENDERED.exec(text.trim())
  if (found === null)
    return null
  const [, id, command, head, base] = found as unknown as [string, string, string, WitnessExpectation, WitnessExpectation]
  return { id, command, head, base }
}

export function judgedCommand(field: WitnessField): string {
  const command = fieldCommand(field)
  if (field.head === 'pass')
    return command
  if (field.head === 'fail')
    return NEGATION.test(command) ? command.replace(NEGATION, '') : `! ( ${command}\n)`
  return `( ${command}\n); test $? -eq ${field.head.slice(EXIT_PREFIX.length)}`
}

export function statesAnExit(field: Pick<WitnessField, 'head' | 'base'>): boolean {
  return [field.head, field.base].some(expectation => expectation.startsWith(EXIT_PREFIX))
}

export function commandInsideJudgedWrap(command: string): string | null {
  const wrapped = JUDGED_WRAP.exec(command.trim())
  return wrapped === null ? null : wrapped[1] ?? wrapped[2]!
}
