import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const EXIT_VALID = 0
const EXIT_REFUSED = 1
const EXIT_USAGE = 2
const ADAPTER_FILE = 'adapter.json'
const ADAPTER_HOME = ['.construct', 'daemon']
const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon-adapter.schema.json')
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git'])
const CORE_IMPORT = /(?:\bfrom|\bimport(?:\s*\()?|\brequire\s*\()\s*['"]mikoshi-construct(?:\/[^'"]*)?['"]/

const USAGE = [
  'usage: daemon.mjs check <.construct/daemon/<name>/adapter.json | its directory>',
  '  exit: 0 the adapter holds to daemon-adapter.schema.json, 1 it does not, 2 a usage error',
].join('\n')

export class UsageError extends Error {}

function typeOf(value) {
  if (value === null)
    return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

export function schemaProblems(schema, value, at = '') {
  const field = at === '' ? 'adapter' : at
  if (schema.type !== undefined && typeOf(value) !== schema.type)
    return [`${field}: must be ${schema.type === 'object' ? 'an' : 'a'} ${schema.type}`]
  if (schema.minLength !== undefined && value.length < schema.minLength)
    return [`${field}: must not be empty`]
  if (schema.type !== 'object')
    return []
  const properties = schema.properties ?? {}
  const prefix = at === '' ? '' : `${at}.`
  const problems = (schema.required ?? [])
    .filter(name => !Object.hasOwn(value, name))
    .map(name => `missing field: ${prefix}${name}`)
  for (const [name, member] of Object.entries(value)) {
    if (Object.hasOwn(properties, name))
      problems.push(...schemaProblems(properties[name], member, `${prefix}${name}`))
    else if (schema.additionalProperties === false)
      problems.push(`unknown field: ${prefix}${name}`)
  }
  return problems
}

export function locateAdapter(argument) {
  const given = path.resolve(argument)
  const file = existsSync(given) && statSync(given).isDirectory() ? path.join(given, ADAPTER_FILE) : given
  const directory = path.dirname(file)
  const home = path.dirname(directory)
  if (path.basename(file) !== ADAPTER_FILE || path.basename(home) !== ADAPTER_HOME[1] || path.basename(path.dirname(home)) !== ADAPTER_HOME[0])
    throw new UsageError(`${argument} is not ${path.join(...ADAPTER_HOME, '<name>', ADAPTER_FILE)}`)
  return { file, directory, name: path.basename(directory), root: path.dirname(path.dirname(home)) }
}

function codeFilesUnder(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : codeFilesUnder(entryPath)
    return entry.isFile() && CODE_FILE.test(entry.name) ? [entryPath] : []
  })
}

function filesNamedBy(command, root) {
  return command.split(/\s+/)
    .map(token => token.replace(/^['"]|['"]$/g, ''))
    .filter(token => token !== '' && CODE_FILE.test(token))
    .map(token => path.resolve(root, token))
    .filter(file => existsSync(file) && statSync(file).isFile())
}

function adapterCodeFiles(adapter, location) {
  const commands = [adapter.extension.build, adapter.prepare, adapter.objects, adapter.success].filter(command => command !== undefined)
  const files = [
    ...codeFilesUnder(location.directory),
    ...codeFilesUnder(path.resolve(location.root, adapter.extension.directory)),
    ...commands.flatMap(command => filesNamedBy(command, location.root)),
  ]
  return [...new Set(files)].sort()
}

function pathProblems(adapter, root) {
  const problems = []
  const extension = path.resolve(root, adapter.extension.directory)
  if (!existsSync(extension) || !statSync(extension).isDirectory())
    problems.push(`extension.directory: ${adapter.extension.directory} is not a directory`)
  const mechanic = path.resolve(root, adapter.mechanic)
  if (!existsSync(mechanic) || !statSync(mechanic).isFile())
    problems.push(`mechanic: ${adapter.mechanic} is not a file`)
  return problems
}

function importProblems(adapter, location) {
  return adapterCodeFiles(adapter, location)
    .filter(file => CORE_IMPORT.test(readFileSync(file, 'utf8')))
    .map(file => `imports mikoshi-construct: ${path.relative(location.root, file)}`)
}

export function checkAdapter(argument, schema = JSON.parse(readFileSync(SCHEMA, 'utf8'))) {
  const location = locateAdapter(argument)
  if (!existsSync(location.file))
    return { name: location.name, problems: [`${path.relative(location.root, location.file)} does not exist`] }
  let adapter
  try {
    adapter = JSON.parse(readFileSync(location.file, 'utf8'))
  }
  catch (error) {
    return { name: location.name, problems: [`${ADAPTER_FILE} is not JSON: ${error.message}`] }
  }
  const shapeProblems = schemaProblems(schema, adapter)
  if (shapeProblems.length > 0)
    return { name: location.name, problems: shapeProblems }
  return { name: location.name, problems: [...pathProblems(adapter, location.root), ...importProblems(adapter, location)] }
}

export function runCommand(argv) {
  const [command, adapter, ...rest] = argv
  if (command !== 'check' || adapter === undefined || rest.length > 0)
    throw new UsageError(command === undefined ? 'no command' : `unknown arguments: ${argv.join(' ')}`)
  const { name, problems } = checkAdapter(adapter)
  if (problems.length === 0)
    return { code: EXIT_VALID, report: [`adapter ${name}: holds to the contract`] }
  return { code: EXIT_REFUSED, report: [`adapter ${name}: refused`, ...problems.map(problem => `  ${problem}`)] }
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

function main() {
  try {
    const result = runCommand(process.argv.slice(2))
    process.stdout.write(`${result.report.join('\n')}\n`)
    process.exit(result.code)
  }
  catch (error) {
    if (!(error instanceof UsageError))
      throw error
    process.stderr.write(`usage error: ${error.message}\n${USAGE}\n`)
    process.exit(EXIT_USAGE)
  }
}

if (isEntry())
  main()
