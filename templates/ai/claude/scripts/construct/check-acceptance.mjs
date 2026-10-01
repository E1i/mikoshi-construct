import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const LABEL = /(Effort|Acceptance|Invariants|Immutable|Design):|(Mutations)(?:\s*\([^)]*\))?:/g
const SENTENCE_END = /[.!?]\s+$/
const FIRST_WORD = /\w+/
const IMPLEMENT_PREFIX = '/implement '
const QUOTED_PATH = /^`([^`]+)`$/
const QUOTED_COMMAND = /^`[\s\S]+`$/
const WITNESS_MARKER = '— witness:'
const CONTRACT_PATHS_LINE = /^Contract paths:(.*)$/m
const CONTRACT_CHECK_LINE = /^Contract check:(.*)$/m
const IMPLEMENT_LINE = /^\/implement /m
const SHA256_HEX = /^[0-9a-f]{64}$/

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

function insideBackticks(text, index) {
  return (text.slice(0, index).match(/`/g)?.length ?? 0) % 2 === 1
}

function isLabel(text, index, name) {
  const before = text.slice(text.lastIndexOf('\n', index - 1) + 1, index)
  if (insideBackticks(before, before.length))
    return false
  if (name === 'Design')
    return before.trim() === ''
  return before.trim() === '' || SENTENCE_END.test(before)
}

export function briefLabels(text) {
  return [...text.matchAll(LABEL)]
    .filter(found => isLabel(text, found.index, found[1] ?? found[2]))
    .map(found => ({ name: found[1] ?? found[2], start: found.index, end: found.index + found[0].length }))
}

function sectionBody(text, name) {
  const labels = briefLabels(text)
  const index = labels.findIndex(label => label.name === name)
  if (index === -1)
    return null
  return text.slice(labels[index].end, labels[index + 1]?.start ?? text.length)
}

function sectionItems(text, name) {
  const body = sectionBody(text, name)
  return body == null ? null : splitOutsideBackticks(body).map(normalizeItem).filter(item => item !== '')
}

function trimItemEdges(item) {
  const trimmed = item.trim()
  return trimmed.endsWith('.') && !insideBackticks(trimmed, trimmed.length - 1) ? trimmed.slice(0, -1) : trimmed
}

function sectionItemsRaw(text, name) {
  const body = sectionBody(text, name)
  return body == null ? null : splitOutsideBackticks(body).map(trimItemEdges).filter(item => item !== '')
}

function briefDesign(text) {
  const body = sectionBody(text, 'Design')
  return body == null ? null : body.trim()
}

function lastMarkerOutsideBackticks(item) {
  let marker = item.lastIndexOf(WITNESS_MARKER)
  while (marker !== -1 && insideBackticks(item, marker))
    marker = item.lastIndexOf(WITNESS_MARKER, marker - 1)
  return marker
}

export function readWitness(item) {
  const marker = lastMarkerOutsideBackticks(item)
  const quoted = marker === -1 ? '' : item.slice(marker + WITNESS_MARKER.length).trim()
  if (!QUOTED_COMMAND.test(quoted))
    return { criterion: normalizeItem(item), command: null, problem: 'no witness' }
  const command = quoted.slice(1, -1)
  if (command.includes('`'))
    return { criterion: normalizeItem(item), command: null, problem: 'backtick' }
  return { criterion: normalizeItem(item.slice(0, marker)), command, problem: null }
}

export function agreedWitnesses(text) {
  return sectionItemsRaw(text, 'Acceptance')?.map(readWitness) ?? null
}

export function agreedItems(text) {
  return agreedWitnesses(text)?.map(item => item.criterion) ?? null
}

export function agreedInvariants(text) {
  return sectionItems(text, 'Invariants') ?? []
}

export function agreedImmutable(text) {
  return (sectionItems(text, 'Immutable') ?? []).map(item => QUOTED_PATH.exec(item)?.[1] ?? item)
}

function briefTask(text) {
  const firstLine = (text.split('\n').find(line => line.trim() !== '') ?? '').trim()
  return firstLine.startsWith(IMPLEMENT_PREFIX) ? firstLine.slice(IMPLEMENT_PREFIX.length).trim() : firstLine
}

function briefEffort(text) {
  return FIRST_WORD.exec(sectionBody(text, 'Effort') ?? '')?.[0] ?? ''
}

function bashSyntaxProblem(command) {
  const result = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' })
  return result.status === 0 ? null : (result.stderr ?? '').trim()
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function witnessDigest({ criterion, command }) {
  return { criterion, sha256: sha256Hex(command) }
}

export function canonicalImplementText(text) {
  const index = text.search(IMPLEMENT_LINE)
  const implementText = index === -1 ? `${IMPLEMENT_PREFIX}${text}` : text.slice(index)
  return implementText.replace(/\n+$/, '')
}

export function buildArgs(text) {
  const agreed = agreedWitnesses(text)
  if (agreed == null)
    throw new InputError('the brief has no Acceptance: section')
  const refused = agreed.filter(item => item.problem != null)
  if (refused.length > 0)
    throw new InputError(refused.map(item => `${item.problem}: ${item.criterion}`).join('\n'))
  const unparseable = agreed
    .map(({ criterion, command }) => ({ criterion, problem: bashSyntaxProblem(command) }))
    .filter(item => item.problem != null)
  if (unparseable.length > 0)
    throw new InputError(unparseable.map(({ criterion, problem }) => `${criterion}\nbash -n\n${problem}`).join('\n'))
  const design = briefDesign(text)
  return {
    task: briefTask(text),
    effort: briefEffort(text),
    agreedSha256: sha256Hex(canonicalImplementText(text)),
    acceptance: agreed.map(item => item.criterion),
    witnesses: agreed.map(({ criterion, command }) => ({ criterion, command })),
    witnessDigests: agreed.map(witnessDigest),
    invariants: agreedInvariants(text),
    immutable: agreedImmutable(text),
    ...(design == null ? {} : { design }),
  }
}

function readRecord(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
  try {
    return JSON.parse(text)
  }
  catch (error) {
    throw new InputError(`${file} is not valid JSON: ${error.message}`)
  }
}

function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return ''
  }
}

function agentsContractLine(root, regex) {
  const agents = readIfPresent(path.join(root, 'AGENTS.md'))
  const found = regex.exec(agents)
  if (found != null)
    return found[1].trim()
  const claude = readIfPresent(path.join(root, 'CLAUDE.md'))
  const foundInClaude = regex.exec(claude)
  if (foundInClaude != null)
    throw new InputError(`${foundInClaude[0].trim()}\nmoved to AGENTS.md`)
  return null
}

function agentsContractPaths(root) {
  const line = agentsContractLine(root, CONTRACT_PATHS_LINE)
  return line == null ? [] : line.split(',').map(item => item.trim()).filter(item => item !== '')
}

function agentsContractCheck(root) {
  return agentsContractLine(root, CONTRACT_CHECK_LINE) ?? ''
}

export function repositoryHarness(root) {
  const record = readRecord(path.join(root, 'construct.json')) ?? readRecord(path.join(root, '.construct', 'attach.json'))
  const command = record?.harness?.command
  if (typeof command !== 'string')
    throw new InputError('no harness command: neither construct.json nor .construct/attach.json names one')
  const recorded = record.contracts == null ? [] : [record.contracts.path, record.contracts.types]
  return {
    command,
    extra: [],
    contractPaths: [...recorded, ...agentsContractPaths(root)].filter(item => typeof item === 'string' && item !== ''),
    contractCheck: agentsContractCheck(root),
  }
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
  return { witnesses, invariants: stringArray(args, 'invariants'), immutable: stringArray(args, 'immutable') }
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
    const { witnesses, invariants, immutable } = argsWitnessing(json)
    const problems = [
      ...missingItems(agreed.map(item => item.criterion), acceptance),
      ...witnessProblems(agreed, witnesses),
      ...missingItems(agreedInvariants(text), invariants).map(item => `invariant missing from the args: ${item}`),
      ...agreedImmutable(text).filter(item => !immutable.includes(item)).map(item => `immutable path missing from the args: ${item}`),
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

function optionalValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] ?? null
}

export function argsHandle(argsPath, json) {
  const { witnesses, design, ...rest } = JSON.parse(json)
  return { argsPath, argsSha256: sha256Hex(json), ...rest, hasDesign: design != null }
}

function writeArgs(argsPath, json) {
  mkdirSync(path.dirname(argsPath), { recursive: true })
  writeFileSync(argsPath, json)
}

export function build(argv) {
  try {
    const text = readInput(option(argv, '--brief'))
    const argsPath = optionalValue(argv, '--out')
    const json = JSON.stringify({ ...buildArgs(text), harness: repositoryHarness(process.cwd()) })
    if (argsPath == null)
      return { code: 0, stdout: [json], stderr: [] }
    writeArgs(argsPath, json)
    return { code: 0, stdout: [JSON.stringify(argsHandle(argsPath, json))], stderr: [] }
  }
  catch (error) {
    if (error instanceof InputError)
      return { code: 2, stdout: [], stderr: error.message.split('\n') }
    throw error
  }
}

function readBytes(file) {
  try {
    return readFileSync(file)
  }
  catch (error) {
    throw new InputError(`cannot read ${file}: ${error.message}`)
  }
}

function witnessCommand(argv) {
  const file = option(argv, '--args')
  const expected = option(argv, '--sha256')
  const wanted = option(argv, '--witness-sha256')
  const bytes = readBytes(file)
  if (!SHA256_HEX.test(expected))
    throw new InputError(`--sha256 ${expected} is not 64 hex characters`)
  if (!SHA256_HEX.test(wanted))
    throw new InputError(`--witness-sha256 ${wanted} is not 64 hex characters`)
  const actual = sha256Hex(bytes)
  if (actual !== expected)
    throw new InputError(`${file} has sha256 ${actual}, and the run was given ${expected}`)
  let args
  try {
    args = JSON.parse(bytes.toString('utf8'))
  }
  catch (error) {
    throw new InputError(`${file} is not valid JSON: ${error.message}`)
  }
  const witnesses = Array.isArray(args?.witnesses) ? args.witnesses : []
  const chosen = witnesses.find(witness => typeof witness?.command === 'string' && sha256Hex(witness.command) === wanted)
  if (chosen == null)
    throw new InputError(`${file} holds no witness with sha256 ${wanted}`)
  return chosen.command
}

export function witness(argv) {
  try {
    return { code: 0, stdout: [witnessCommand(argv)], stderr: [] }
  }
  catch (error) {
    if (error instanceof InputError)
      return { code: 2, stdout: [], stderr: [error.message] }
    throw error
  }
}

const MODES = { build, witness }

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isEntry()) {
  const [mode, ...rest] = process.argv.slice(2)
  const result = Object.hasOwn(MODES, mode) ? MODES[mode](rest) : check(process.argv.slice(2))
  if (mode === 'witness') {
    process.stdout.write(result.stdout.join(''))
  }
  else {
    for (const line of result.stdout)
      process.stdout.write(`${line}\n`)
  }
  for (const line of result.stderr)
    process.stderr.write(`${line}\n`)
  process.exitCode = result.code
}
