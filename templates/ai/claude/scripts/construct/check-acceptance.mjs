import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ACCEPTANCE_LABEL = /(?:^|\s)Acceptance:/
const INVARIANTS_LABEL = /(?:^|\s)Invariants:/
const SECTION_END = {
  acceptance: /(?:^|\n|[.!?]\s*)(?:Mutations|Invariants):/,
  invariants: /(?:^|\n|[.!?]\s*)(?:Mutations|Acceptance):/,
}
const WITNESS_MARKER = '— witness:'
const QUOTED_COMMAND = /^`([^`]+)`$/

export class InputError extends Error {}

export function normalizeItem(item) {
  return item.trim().replace(/\s+/g, ' ').replace(/\.$/, '')
}

function splitOutsideBackticks(body) {
  const items = ['']
  let quoted = false
  for (const character of body) {
    if (character === '`')
      quoted = !quoted
    if (character === ';' && !quoted)
      items.push('')
    else
      items[items.length - 1] += character
  }
  return items
}

function sectionItems(text, label, end) {
  const found = label.exec(text)
  if (found == null)
    return null
  const section = text.slice(found.index + found[0].length)
  const stop = end.exec(section)
  const body = stop == null ? section : section.slice(0, stop.index)
  return splitOutsideBackticks(body).map(normalizeItem).filter(item => item !== '')
}

function withWitness(item) {
  const marker = item.lastIndexOf(WITNESS_MARKER)
  const command = marker === -1 ? null : QUOTED_COMMAND.exec(item.slice(marker + WITNESS_MARKER.length).trim())?.[1]
  return command == null ? { criterion: item, command: null } : { criterion: normalizeItem(item.slice(0, marker)), command }
}

export function agreedWitnesses(text) {
  return sectionItems(text, ACCEPTANCE_LABEL, SECTION_END.acceptance)?.map(withWitness) ?? null
}

export function agreedItems(text) {
  return agreedWitnesses(text)?.map(item => item.criterion) ?? null
}

export function agreedInvariants(text) {
  return sectionItems(text, INVARIANTS_LABEL, SECTION_END.invariants) ?? []
}

export function argsAcceptance(json) {
  let args
  try {
    args = JSON.parse(json)
  }
  catch (error) {
    throw new InputError(`the args are not valid JSON: ${error.message}`)
  }
  const acceptance = args?.acceptance ?? []
  if (!Array.isArray(acceptance) || acceptance.some(item => typeof item !== 'string'))
    throw new InputError('args.acceptance is not an array of strings')
  return acceptance
}

function stringArray(args, key) {
  const value = args?.[key] ?? []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
    throw new InputError(`args.${key} is not an array of strings`)
  return value
}

export function argsWitnessing(json) {
  const args = JSON.parse(json)
  const witnesses = args?.witnesses ?? []
  if (!Array.isArray(witnesses) || witnesses.some(witness => typeof witness?.criterion !== 'string' || typeof witness?.command !== 'string'))
    throw new InputError('args.witnesses is not an array of { criterion, command } strings')
  return { witnesses, invariants: stringArray(args, 'invariants') }
}

export function witnessProblems(agreed, witnesses) {
  return agreed.flatMap(({ criterion, command }) => {
    if (command == null)
      return [`no witness in the brief: ${criterion}`]
    const matched = witnesses.some(witness => normalizeItem(witness.criterion) === criterion && witness.command === command)
    return matched ? [] : [`the witness in the args is not the brief's: ${criterion}`]
  })
}

export function missingItems(agreed, acceptance) {
  const present = new Set(acceptance.map(normalizeItem))
  return agreed.filter(item => !present.has(item))
}

function option(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1 || argv[index + 1] == null)
    throw new InputError(`${name} <file> is required`)
  return argv[index + 1]
}

function readInput(file) {
  try {
    return readFileSync(file, 'utf8')
  }
  catch (error) {
    throw new InputError(`cannot read ${file}: ${error.message}`)
  }
}

export function check(argv) {
  try {
    const text = readInput(option(argv, '--agreed'))
    const json = readInput(option(argv, '--args'))
    const agreed = agreedWitnesses(text)
    const acceptance = argsAcceptance(json)
    if (agreed == null)
      return { code: 0, stdout: ['The agreed line has no Acceptance: section; nothing was agreed to check.'], stderr: [] }
    const { witnesses, invariants } = argsWitnessing(json)
    const problems = [
      ...missingItems(agreed.map(item => item.criterion), acceptance),
      ...witnessProblems(agreed, witnesses),
      ...missingItems(agreedInvariants(text), invariants).map(item => `invariant missing from the args: ${item}`),
    ]
    if (problems.length > 0)
      return { code: 1, stdout: [], stderr: problems }
    return { code: 0, stdout: [`Every agreed acceptance item is in the args with the brief's witness (${agreed.length}).`], stderr: [] }
  }
  catch (error) {
    if (error instanceof InputError)
      return { code: 2, stdout: [], stderr: [error.message] }
    throw error
  }
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isEntry()) {
  const result = check(process.argv.slice(2))
  for (const line of result.stdout)
    process.stdout.write(`${line}\n`)
  for (const line of result.stderr)
    process.stderr.write(`${line}\n`)
  process.exitCode = result.code
}
