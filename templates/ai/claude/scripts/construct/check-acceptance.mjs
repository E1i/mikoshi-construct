import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ACCEPTANCE_LABEL = /(?:^|\s)Acceptance:/
const MUTATIONS_LABEL = /(?:^|\n|[.!?]\s*)Mutations:/

export class InputError extends Error {}

export function normalizeItem(item) {
  return item.trim().replace(/\s+/g, ' ').replace(/\.$/, '')
}

export function agreedItems(text) {
  const label = ACCEPTANCE_LABEL.exec(text)
  if (label == null)
    return null
  const section = text.slice(label.index + label[0].length)
  const end = MUTATIONS_LABEL.exec(section)
  const body = end == null ? section : section.slice(0, end.index)
  return body.split(';').map(normalizeItem).filter(item => item !== '')
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
    const agreed = agreedItems(readInput(option(argv, '--agreed')))
    const acceptance = argsAcceptance(readInput(option(argv, '--args')))
    if (agreed == null)
      return { code: 0, stdout: ['The agreed line has no Acceptance: section; nothing was agreed to check.'], stderr: [] }
    const missing = missingItems(agreed, acceptance)
    if (missing.length > 0)
      return { code: 1, stdout: [], stderr: missing }
    return { code: 0, stdout: [`Every agreed acceptance item is in the args (${agreed.length}).`], stderr: [] }
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
