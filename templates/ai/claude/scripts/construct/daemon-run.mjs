import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checkAdapter, locateAdapter, UsageError } from './daemon.mjs'

const EXIT_DONE = 0
const EXIT_REFUSED = 1
const EXIT_USAGE = 2
const EVIDENCE_FILE = 'evidence.json'
const CONSOLE_FILE = 'console.json'
const LAB_OUTPUT = /^lab-.+\.json$/
const SCREENSHOT = /\.png$/
const SAFE_ID = /^[\w.-]+$/
const RUN_ID = /^\d{8}T\d{9}Z-\d+$/
const DAEMON_HOME = path.join('.construct', 'daemon')

export const VERDICTS = { 0: 'holds', 1: 'false' }
export const UNOBSERVED = 'unobserved'

const USAGE = [
  'usage: daemon-run.mjs <command> <.construct/daemon/<name> | its adapter.json> …',
  '  objects <adapter> [--run <id>]                 build the extension, list the objects; prints {run, objects, mechanic, extension}',
  '  prepare <adapter> <run> <object>               copy the extension, run the adapter\'s prepare on the copy; prints {prepared, labCopy, evidence}',
  '  verdict <adapter> <run> <object> --agent <id> [--lab <path>]  run the adapter\'s success on the evidence directory, write evidence.json, remove the lab copy',
  '  unobserved <adapter> <run> <object> --line <text> [--agent <id>] [--lab <path>]  write evidence.json as unobserved, remove the lab copy',
  '  exit: 0 done, 1 the adapter or a step refused, 2 a usage error',
].join('\n')

export class Refused extends Error {}

function quoted(argument) {
  return `'${String(argument).replace(/'/g, `'\\''`)}'`
}

function shell(command, root, args = []) {
  const result = spawnSync([command, ...args.map(quoted)].join(' '), { cwd: root, shell: true, encoding: 'utf8' })
  return { exitCode: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function firstLine(...texts) {
  return texts.join('\n').split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

function ended(result) {
  if (result.exitCode !== null)
    return `exited ${result.exitCode}`
  return result.signal === null ? 'ended without an exit code' : `ended without an exit code: ${result.signal}`
}

export function runId(now = new Date(), pid = process.pid) {
  return `${now.toISOString().replace(/[-:.]/g, '')}-${pid}`
}

function readAdapter(argument) {
  const { name, problems } = checkAdapter(argument)
  if (problems.length > 0)
    throw new Refused([`adapter ${name}: refused`, ...problems.map(problem => `  ${problem}`)].join('\n'))
  const location = locateAdapter(argument)
  return { location, adapter: JSON.parse(readFileSync(location.file, 'utf8')) }
}

function objectDirectory(root, run, object) {
  if (!RUN_ID.test(run))
    throw new UsageError(`${run} is not a run id`)
  if (!SAFE_ID.test(object))
    throw new UsageError(`${object} is not an object id`)
  return path.join(root, DAEMON_HOME, run, object)
}

export function parseObjects(stdout) {
  const lines = stdout.split('\n').filter(line => line.trim() !== '')
  const seen = new Set()
  return lines.map((line, index) => {
    let value
    try {
      value = JSON.parse(line)
    }
    catch {
      throw new Refused(`objects line ${index + 1} is not JSON: ${line}`)
    }
    if (typeof value !== 'object' || value === null || typeof value.id !== 'string' || !SAFE_ID.test(value.id))
      throw new Refused(`objects line ${index + 1} has no id of letters, digits, '.', '_' or '-': ${line}`)
    if (seen.has(value.id))
      throw new Refused(`objects line ${index + 1} repeats the id ${value.id}: ${line}`)
    seen.add(value.id)
    return value
  })
}

export function listObjects(argument, run = runId()) {
  if (!RUN_ID.test(run))
    throw new UsageError(`${run} is not a run id`)
  const { location, adapter } = readAdapter(argument)
  if (adapter.extension.build !== undefined) {
    const build = shell(adapter.extension.build, location.root)
    if (build.exitCode !== 0)
      throw new Refused(`extension.build ${ended(build)}: ${firstLine(build.stderr, build.stdout)}`)
  }
  const listed = shell(adapter.objects, location.root)
  if (listed.exitCode !== 0)
    throw new Refused(`objects ${ended(listed)}: ${firstLine(listed.stderr, listed.stdout)}`)
  return {
    run,
    adapter: location.name,
    mechanic: adapter.mechanic,
    extension: adapter.extension.directory,
    objects: parseObjects(listed.stdout).map(object => object.id),
  }
}

function writeEvidence(directory, evidence) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, EVIDENCE_FILE), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

export function unobservedEvidence(object, line, agent = null) {
  return { object, verdict: UNOBSERVED, line, lab: [], screenshot: null, console: null, agent }
}

export function removeLabCopy(object, labCopy) {
  if (labCopy === undefined || !existsSync(labCopy))
    return false
  const resolved = realpathSync(labCopy)
  const inTemporaryDirectory = path.dirname(resolved) === realpathSync(os.tmpdir())
  if (!inTemporaryDirectory || !path.basename(resolved).startsWith(`daemon-${object}-`))
    return false
  rmSync(resolved, { recursive: true, force: true })
  return true
}

export function prepareObject(argument, run, object, labRoot = os.tmpdir()) {
  const { location, adapter } = readAdapter(argument)
  const directory = objectDirectory(location.root, run, object)
  mkdirSync(directory, { recursive: true })
  const labCopy = realpathSync(mkdtempSync(path.join(labRoot, `daemon-${object}-`)))
  cpSync(path.resolve(location.root, adapter.extension.directory), labCopy, { recursive: true })
  const prepared = shell(adapter.prepare, location.root, [labCopy, object])
  const evidence = relative(location.root, directory)
  if (prepared.exitCode === 0)
    return { prepared: true, labCopy, evidence, line: firstLine(prepared.stdout, prepared.stderr) }
  const line = `prepare ${ended(prepared)}: ${firstLine(prepared.stderr, prepared.stdout)}`
  writeEvidence(directory, unobservedEvidence(object, line))
  removeLabCopy(object, labCopy)
  return { prepared: false, labCopy: null, evidence, line }
}

export function recordUnobserved(argument, run, object, line, agent = null, lab = undefined) {
  const { root } = locateAdapter(argument)
  const evidence = writeEvidence(objectDirectory(root, run, object), unobservedEvidence(object, line, agent))
  removeLabCopy(object, lab)
  return evidence
}

export function labOutputs(root, directory) {
  const names = existsSync(directory) ? readdirSync(directory).sort() : []
  const file = name => relative(root, path.join(directory, name))
  return {
    lab: names.filter(name => LAB_OUTPUT.test(name)).map(file),
    screenshot: names.filter(name => SCREENSHOT.test(name)).map(file)[0] ?? null,
    console: names.includes(CONSOLE_FILE) ? file(CONSOLE_FILE) : null,
  }
}

export function judgeObject(argument, run, object, agent, lab = undefined) {
  const { location, adapter } = readAdapter(argument)
  const directory = objectDirectory(location.root, run, object)
  const judged = shell(adapter.success, location.root, [relative(location.root, directory)])
  const verdict = VERDICTS[judged.exitCode] ?? UNOBSERVED
  const line = judged.exitCode === null ? `success ${ended(judged)}` : firstLine(judged.stdout, judged.stderr)
  const evidence = writeEvidence(directory, { object, verdict, line, ...labOutputs(location.root, directory), agent })
  removeLabCopy(object, lab)
  return evidence
}

function optionValue(rest, flag) {
  const index = rest.indexOf(flag)
  if (index === -1)
    return { value: undefined, positionals: rest }
  if (rest[index + 1] === undefined)
    throw new UsageError(`${flag} needs a value`)
  return { value: rest[index + 1], positionals: [...rest.slice(0, index), ...rest.slice(index + 2)] }
}

export function runCommand(argv) {
  const [command, ...rest] = argv
  if (command === 'objects') {
    const { value: run, positionals } = optionValue(rest, '--run')
    if (positionals.length !== 1)
      throw new UsageError('objects takes one adapter')
    return listObjects(positionals[0], run)
  }
  if (command === 'prepare') {
    if (rest.length !== 3)
      throw new UsageError('prepare takes an adapter, a run and an object')
    return prepareObject(rest[0], rest[1], rest[2])
  }
  if (command === 'verdict') {
    const { value: agent, positionals: withoutAgent } = optionValue(rest, '--agent')
    const { value: lab, positionals } = optionValue(withoutAgent, '--lab')
    if (positionals.length !== 3 || agent === undefined)
      throw new UsageError('verdict takes an adapter, a run, an object and --agent')
    return judgeObject(positionals[0], positionals[1], positionals[2], agent, lab)
  }
  if (command === 'unobserved') {
    const { value: line, positionals: withoutLine } = optionValue(rest, '--line')
    const { value: agent, positionals: withoutAgent } = optionValue(withoutLine, '--agent')
    const { value: lab, positionals } = optionValue(withoutAgent, '--lab')
    if (positionals.length !== 3 || line === undefined)
      throw new UsageError('unobserved takes an adapter, a run, an object and --line')
    return recordUnobserved(positionals[0], positionals[1], positionals[2], line, agent ?? null, lab)
  }
  throw new UsageError(command === undefined ? 'no command' : `unknown command: ${command}`)
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(runCommand(process.argv.slice(2)))}\n`)
    process.exit(EXIT_DONE)
  }
  catch (error) {
    if (error instanceof Refused) {
      process.stderr.write(`${error.message}\n`)
      process.exit(EXIT_REFUSED)
    }
    if (!(error instanceof UsageError))
      throw error
    process.stderr.write(`usage error: ${error.message}\n${USAGE}\n`)
    process.exit(EXIT_USAGE)
  }
}

if (isEntry())
  main()
