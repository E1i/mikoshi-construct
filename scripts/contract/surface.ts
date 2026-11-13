import type { ArgsDef, CommandDef } from 'citty'
import type { JsonForms, JsonKeys, ObservedCli } from './json-samples.js'
import type { SurfaceReading, Unbaselined } from './semantic-diff.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { ATLAS_EXIT } from '../../src/atlas/index.js'
import { ATTACH_EXIT, SETTINGS_FILE } from '../../src/commands/attach/index.js'
import { BOARD_EXIT } from '../../src/commands/board/index.js'
import { COST_EXIT } from '../../src/commands/cost/index.js'
import { DETACH_EXIT } from '../../src/commands/detach/index.js'
import { DOCTOR_EXIT } from '../../src/commands/doctor/index.js'
import { GRAPH_EXIT } from '../../src/commands/graph.js'
import { INIT_EXIT } from '../../src/commands/init.js'
import { INTAKE_EXIT } from '../../src/commands/intake/index.js'
import { MUTATE_APPLY_EXIT, MUTATE_JUDGE_EXIT } from '../../src/commands/mutate/index.js'
import { RUN_RECORD_EXIT } from '../../src/commands/run-record.js'
import { SOULKILL_EXIT } from '../../src/commands/soulkill.js'
import { SYNC_APPLY_EXIT, SYNC_EXIT } from '../../src/commands/sync/index.js'
import { FAILED_EXIT } from '../../src/failure.js'
import { DISCOVERY_MARKERS } from '../../src/manifest.js'
import { blockMarkers, discoveryTags } from '../../src/materialize/strategies.js'
import { PRESET_LIST } from '../../src/presets/index.js'
import { main, SAY_EXIT } from '../../src/program.js'
import { processGit } from '../ports/git.js'
import { contourSchemaNames, readContourSchema, schemaId } from './contours.js'
import { commandFromHelp, listsCommands, usageCommands } from './help.js'
import { cliArgs, cliEnv, failureLine, HEAD_CLI, headJson, tagCli, tagJsonKeys } from './json-samples.js'
import { isUnbaselined, unbaselined } from './semantic-diff.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const ATTACH_SAMPLE = path.join(REPO_ROOT, 'tests/fixtures/existing-monorepo')
const GIT_EXCLUDE = '.git/info/exclude'
const EXITS_NOT_OBSERVABLE = 'exit codes are not observable from the tag\'s output'
const MARKERS_NOT_OBSERVABLE = 'block and discovery markers are read from the source\'s exports, not from the tag\'s output'
const CONTOURS_NOT_OBSERVABLE = 'contour schemas are read from contract/contours/, not from the tag\'s output'
const JSON_FORMS_NOT_OBSERVABLE = 'json forms are the flags of the head\'s samples, not an output of the tag'
const OUTSIDE_NOT_OBSERVABLE = 'what lies outside the contract is a recorded decision, not an output of the tag'
const AVAILABLE_PRESETS = 'import(\'./src/presets/index.ts\').then(m => console.log(JSON.stringify(m.PRESET_LIST.filter(p => p.available !== false).map(p => p.id))))'
const MANIFEST_FILE = 'package.json'
const CONTRIBUTING_FILE = 'CONTRIBUTING.md'
const SCRIPTS_HEADING = '## Scripts'
const SCRIPT_ROW = /^\| `pnpm (?:run )?([\w:-]+)[ `]/
const IN_THE_HARNESS = 'In the harness.'
const UNDECLARED_FLAG_PROBE = '--undeclared-flag-probe'
const PROBE_TIMEOUT_MS = 60_000
const FLAGS_OF_EVERY_FORM = new Set(['json', 'plain', 'johnny'])
const TSX_ENTRY = /node --import tsx (\S+\.ts)(?=\s|$)/g
const FLAG_AT_START = /^--([a-z][\w-]*)/
const FLAG_NAME = /^[a-z][\w-]*$/
const FLAG_PREFIX_AT_END = /(?:^|[^\w-])--$/
const JSON_FLAG = 'json'
const PARSE_ARGS = 'parseArgs'
const CONSTANT_DEPTH = 8
const SYNC_APPLY_FORM = 'sync --apply'
const VERSION_CONSTANT = 'SURFACE_VERSION'

export const GENERATED_SURFACE_FROM = `export const ${VERSION_CONSTANT} = `

export const REFUSED_BY_STRICT_PARSE_ARGS = 'strict parseArgs'
export const REFUSAL_NOT_READ = 'not read'

export type ScriptRefusal = typeof REFUSED_BY_STRICT_PARSE_ARGS | typeof REFUSAL_NOT_READ

export interface ScriptSurface {
  entries: string[]
  flags: string[]
  json: boolean
  exits: number[]
  unknownFlag: ScriptRefusal
}

export const SURFACE_VERSION = 3

export const CONTRACT_FORMATS = {
  manifestVersion: 6,
  modelVersion: 6,
  recordVersion: 4,
} as const

export type ContractFormat = keyof typeof CONTRACT_FORMATS

export const CONTRACT_COMMANDS = [
  'atlas',
  'attach',
  'board',
  'cost',
  'detach',
  'doctor',
  'graph',
  'init',
  'intake',
  'mutate apply',
  'mutate judge',
  'run-record',
  'say',
  'soulkill',
  'sync',
] as const

export type ContractCommand = typeof CONTRACT_COMMANDS[number]

export function formatVersion(file: string, field: ContractFormat): number {
  const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)[field]
  if (typeof value !== 'number')
    throw new Error(`${file} carries no numeric ${field} that contract/surface.json declares in formats`)
  return value
}

export const REPORT_CONTRACT = {
  countLine: '■ \\d+ □ \\d+ · \\d+',
  countLineRefusal: 'no_matrix_count_line',
  countLineUnder: ['src/', 'templates/'],
  file: '.construct/report.md',
  reportVersion: 1,
} as const

export function reportWithoutCountLine(report: string, files: readonly string[]): string | undefined {
  return new RegExp(REPORT_CONTRACT.countLine).test(report) ? undefined : files.find(file => REPORT_CONTRACT.countLineUnder.some(root => file.startsWith(root)))
}

export const OUTSIDE_THE_CONTRACT = [
  '.construct/turns.jsonl',
  'graph --out HTML',
  'human-readable output text',
  'lore strings',
]

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface Flag {
  type: string
  alias?: string
  options?: string[]
}

export type CommandSurface = { flags: Record<string, Flag> } | { aliasOf: string }

export interface Surface {
  surfaceVersion: number
  commands: Record<string, CommandSurface>
  exits: Record<string, Record<string, number>>
  jsonKeys: JsonKeys
  jsonForms: JsonForms
  unknownFlag: Record<string, number>
  formats: { manifestVersion: number, modelVersion: number, recordVersion: number }
  paths: { init: Record<string, string[]>, attach: { writes: string[], edits: string[] } }
  markers: { block: string[][], discover: { tags: string[], markers: string[] } }
  contours: Record<string, string>
  outside: string[]
  scripts: Record<string, ScriptSurface>
  report?: ReportContract
}

export interface ReportContract {
  countLine: string
  countLineRefusal: string
  countLineUnder: string[]
  file: string
  reportVersion: number
}

export interface ScriptRegistry {
  scripts: Record<string, string>
  scriptsOutsideTheHarness: Record<string, string>
}

export function scriptRegistry(root = REPO_ROOT): ScriptRegistry {
  return JSON.parse(readFileSync(path.join(root, MANIFEST_FILE), 'utf8')) as ScriptRegistry
}

function writeScriptsTable(root: string): string {
  const contributing = path.join(root, CONTRIBUTING_FILE)
  writeFileSync(contributing, renderScriptsTable(readFileSync(contributing, 'utf8'), scriptRegistry(root)))
  return contributing
}

export function scriptNames(registry: ScriptRegistry): string[] {
  return Object.keys(registry.scripts).sort()
}

type Constants = Map<string, ts.Expression>

interface EntryReading {
  flags: Set<string>
  exits: Set<number>
  refuses: boolean
}

function unwrapped(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current))
    current = current.expression
  return current
}

function constantsOf(source: ts.SourceFile): Constants {
  const constants: Constants = new Map()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer != null)
      constants.set(node.name.text, unwrapped(node.initializer))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return constants
}

function resolved(expression: ts.Expression, constants: Constants, depth = CONSTANT_DEPTH): ts.Expression {
  const current = unwrapped(expression)
  const target = ts.isIdentifier(current) ? constants.get(current.text) : undefined
  return target == null || depth === 0 ? current : resolved(target, constants, depth - 1)
}

function literalOf(expression: ts.Expression, constants: Constants): string | number | undefined {
  const value = resolved(expression, constants)
  if (ts.isStringLiteralLike(value))
    return value.text
  return ts.isNumericLiteral(value) ? Number(value.text) : undefined
}

function propertyName(name: ts.PropertyName, constants: Constants): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name))
    return name.text
  if (!ts.isComputedPropertyName(name))
    return undefined
  const value = literalOf(name.expression, constants)
  return typeof value === 'string' ? value : undefined
}

function objectProperties(expression: ts.Expression | undefined, constants: Constants): ts.PropertyAssignment[] {
  const value = expression == null ? undefined : resolved(expression, constants)
  return value != null && ts.isObjectLiteralExpression(value) ? value.properties.filter(ts.isPropertyAssignment) : []
}

function readParseArgs(call: ts.CallExpression, constants: Constants, into: EntryReading): void {
  const config = objectProperties(call.arguments[0], constants)
  const named = (name: string): ts.PropertyAssignment | undefined => config.find(property => propertyName(property.name, constants) === name)
  for (const option of objectProperties(named('options')?.initializer, constants)) {
    const flag = propertyName(option.name, constants)
    if (flag != null)
      into.flags.add(flag)
  }
  if (named('strict')?.initializer.kind !== ts.SyntaxKind.FalseKeyword)
    into.refuses = true
}

function readFlagsInTemplate(template: ts.TemplateExpression, constants: Constants, into: EntryReading): void {
  const texts = [template.head.text, ...template.templateSpans.map(span => span.literal.text)]
  template.templateSpans.forEach((span, at) => {
    const value = FLAG_PREFIX_AT_END.test(texts[at]) ? literalOf(span.expression, constants) : undefined
    if (typeof value === 'string' && FLAG_NAME.test(value))
      into.flags.add(value)
  })
  const leading = FLAG_AT_START.exec(template.head.text)?.[1]
  if (leading != null)
    into.flags.add(leading)
}

function exitCodeOf(node: ts.Node, constants: Constants): number | undefined {
  const isExitCode = (target: ts.Node): boolean => ts.isPropertyAccessExpression(target) && target.name.text === 'exitCode'
  const code = (expression: ts.Expression): number | undefined => {
    const value = literalOf(expression, constants)
    return typeof value === 'number' ? value : undefined
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isExitCode(node.left))
    return code(node.right)
  if (ts.isCallExpression(node) && node.expression.getText() === 'process.exit' && node.arguments[0] != null)
    return code(node.arguments[0])
  if (ts.isPropertyAssignment(node) && propertyName(node.name, constants) === 'exitCode')
    return code(node.initializer)
  return undefined
}

function readEntry(file: string, into: EntryReading): void {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const constants = constantsOf(source)
  const visit = (node: ts.Node): void => {
    const leading = ts.isStringLiteralLike(node) ? FLAG_AT_START.exec(node.text)?.[1] : undefined
    if (leading != null)
      into.flags.add(leading)
    if (ts.isTemplateExpression(node))
      readFlagsInTemplate(node, constants, into)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === PARSE_ARGS)
      readParseArgs(node, constants, into)
    const exit = exitCodeOf(node, constants)
    if (exit != null)
      into.exits.add(exit)
    ts.forEachChild(node, visit)
  }
  visit(source)
}

function scriptSurface(command: string, root: string): ScriptSurface {
  const entries = [...new Set([...command.matchAll(TSX_ENTRY)].map(match => match[1]))]
  const reading: EntryReading = { flags: new Set(), exits: new Set(), refuses: false }
  for (const entry of entries)
    readEntry(path.join(root, entry), reading)
  return {
    entries,
    flags: [...reading.flags].sort(),
    json: reading.flags.has(JSON_FLAG),
    exits: [...reading.exits].sort((a, b) => a - b),
    unknownFlag: reading.refuses ? REFUSED_BY_STRICT_PARSE_ARGS : REFUSAL_NOT_READ,
  }
}

export function scriptSurfaces(root = REPO_ROOT): Record<string, ScriptSurface> {
  const registry = scriptRegistry(root)
  return Object.fromEntries(scriptNames(registry).map(name => [name, scriptSurface(registry.scripts[name], root)]))
}

function undeclaredOfScript(name: string, script: ScriptSurface, declared: ScriptSurface | undefined): string[] {
  if (declared == null)
    return [`pnpm ${name}: the script is not declared`]
  return [
    ...script.flags.filter(flag => !declared.flags.includes(flag)).map(flag => `pnpm ${name} --${flag}: the flag is not declared`),
    ...(script.json && !declared.json ? [`pnpm ${name} --${JSON_FLAG}: the json form is not declared`] : []),
    ...script.exits.filter(code => !declared.exits.includes(code)).map(code => `pnpm ${name}: exit ${code} is not declared`),
    ...(script.unknownFlag === declared.unknownFlag ? [] : [`pnpm ${name} ${UNDECLARED_FLAG_PROBE}: the refusal of an unknown flag reads as ${script.unknownFlag}, declared as ${declared.unknownFlag}`]),
  ]
}

export function undeclaredScripts(recorded: Record<string, ScriptSurface>, head: Record<string, ScriptSurface>): string[] {
  return Object.entries(head).flatMap(([name, script]) => undeclaredOfScript(name, script, recorded[name]))
}

function scriptRow(name: string, registry: ScriptRegistry): string {
  const what = (registry.scriptsOutsideTheHarness[name] ?? IN_THE_HARNESS).replace(/\s+/g, ' ').replaceAll('|', '\\|')
  return `| \`pnpm ${name}\` | ${what} | \`pnpm ${name}\` |`
}

export function renderScriptsTable(contributing: string, registry: ScriptRegistry): string {
  const lines = contributing.split('\n')
  const start = lines.indexOf(SCRIPTS_HEADING)
  const next = lines.findIndex((line, at) => at > start && line.startsWith('## '))
  const end = next === -1 ? lines.length : next
  const section = lines.slice(start, end)
  const lastRow = section.map(line => SCRIPT_ROW.test(line)).lastIndexOf(true)
  if (start === -1 || lastRow === -1)
    throw new Error(`CONTRIBUTING.md has no rows under "${SCRIPTS_HEADING}" to keep the scripts in`)
  const rowName = (line: string): string | undefined => SCRIPT_ROW.exec(line)?.[1]
  const table = section.slice(0, lastRow + 1)
  const listed = new Set(table.flatMap(line => rowName(line) ?? []))
  const kept = table.filter((line) => {
    const name = rowName(line)
    return name === undefined || name in registry.scripts
  })
  const added = Object.keys(registry.scripts).filter(name => !listed.has(name)).map(name => scriptRow(name, registry))
  return [...lines.slice(0, start), ...kept, ...added, ...section.slice(lastRow + 1), ...lines.slice(end)].join('\n')
}

function subCommandsOf(command: CommandDef, name: string): Record<string, CommandDef> | null {
  const subCommands = command.subCommands
  if (subCommands == null)
    return null
  if (typeof subCommands !== 'object')
    throw new Error(`${name}.subCommands is not a plain object`)
  return subCommands as Record<string, CommandDef>
}

function commandsUnder(parent: CommandDef, prefix: string, firstName: Map<unknown, string>, commands: Record<string, CommandSurface>): void {
  for (const [ownName, command] of Object.entries(subCommandsOf(parent, prefix || 'main') ?? {})) {
    const name = prefix === '' ? ownName : `${prefix} ${ownName}`
    const target = firstName.get(command)
    if (target != null) {
      commands[name] = { aliasOf: target }
      continue
    }
    firstName.set(command, name)
    if (subCommandsOf(command, name) != null)
      commandsUnder(command, name, firstName, commands)
    else
      commands[name] = { flags: flagsOf(command.args) }
  }
}

function commandsOf(root: CommandDef): Record<string, CommandSurface> {
  if (subCommandsOf(root, 'main') == null)
    throw new Error('main.subCommands is not a plain object')
  const commands: Record<string, CommandSurface> = {}
  commandsUnder(root, '', new Map(), commands)
  return commands
}

function flagsOf(args: CommandDef['args']): Record<string, Flag> {
  if (args == null)
    return {}
  if (typeof args !== 'object')
    throw new Error('a command declares its args as something other than a plain object')
  return Object.fromEntries(Object.entries(args as ArgsDef).map(([name, arg]) => {
    const declared = 'alias' in arg ? arg.alias : undefined
    const alias = Array.isArray(declared) ? declared.join(',') : declared
    const options = 'options' in arg ? arg.options : undefined
    const flag: Flag = { type: String(arg.type ?? 'string') }
    if (alias != null)
      flag.alias = alias
    if (options != null)
      flag.options = options
    return [name, flag]
  }))
}

function withFailed(table: Record<string, number>): Record<string, number> {
  return { ...table, failed: FAILED_EXIT }
}

export function exitTables(): Record<ContractCommand | typeof SYNC_APPLY_FORM, Record<string, number>> {
  return {
    'init': withFailed(INIT_EXIT),
    'attach': withFailed(ATTACH_EXIT),
    'detach': withFailed(DETACH_EXIT),
    'soulkill': withFailed(SOULKILL_EXIT),
    'doctor': withFailed(DOCTOR_EXIT),
    'sync': withFailed(SYNC_EXIT),
    [SYNC_APPLY_FORM]: withFailed(SYNC_APPLY_EXIT),
    'board': withFailed(BOARD_EXIT),
    'cost': withFailed(COST_EXIT),
    'graph': withFailed(GRAPH_EXIT),
    'intake': withFailed(INTAKE_EXIT),
    'mutate apply': withFailed(MUTATE_APPLY_EXIT),
    'mutate judge': withFailed(MUTATE_JUDGE_EXIT),
    'atlas': withFailed(ATLAS_EXIT),
    'say': withFailed(SAY_EXIT),
    'run-record': withFailed(RUN_RECORD_EXIT),
  }
}

function runCli(cli: ObservedCli, args: string[], dir: string, home: string): void {
  execFileSync(process.execPath, cliArgs(cli, [...args, '--dir', dir]), { env: cliEnv(home), stdio: 'ignore' })
}

function filesUnder(root: string, relative = ''): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (child === '.git')
      return []
    return entry.isDirectory() ? filesUnder(root, child) : [child]
  })
}

interface Runs {
  formats: Surface['formats']
  paths: Surface['paths']
}

function observedRuns(cli: ObservedCli, presets: string[]): Runs {
  const scratch = mkdtempSync(path.join(tmpdir(), 'construct-surface-'))
  try {
    const home = path.join(scratch, 'home')
    mkdirSync(home)
    const init: Record<string, string[]> = {}
    let initialised = ''
    for (const preset of presets) {
      const dir = path.join(scratch, `init-${preset}`)
      mkdirSync(dir)
      runCli(cli, ['init', '--yes', '--preset', preset], dir, home)
      init[preset] = filesUnder(dir).sort()
      initialised = dir
    }

    const repository = path.join(scratch, 'attach')
    execFileSync('cp', ['-R', ATTACH_SAMPLE, repository])
    processGit.read(repository, ['init', '-q'])
    const before = new Set(filesUnder(repository))
    runCli(cli, ['attach', '--yes', '--harness', 'pnpm run quality', '--required-check', 'quality'], repository, home)
    const writes = filesUnder(repository).filter(file => !before.has(file)).sort()

    return {
      formats: {
        manifestVersion: formatVersion(path.join(initialised, 'construct.json'), 'manifestVersion'),
        modelVersion: formatVersion(path.join(initialised, 'construct.model.json'), 'modelVersion'),
        recordVersion: formatVersion(path.join(repository, '.construct/attach.json'), 'recordVersion'),
      },
      paths: { init, attach: { writes, edits: [GIT_EXCLUDE, SETTINGS_FILE] } },
    }
  }
  finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function markers(): Surface['markers'] {
  return {
    block: [blockMarkers('AGENTS.md'), blockMarkers('.gitignore')],
    discover: { tags: discoveryTags('<marker>'), markers: [...DISCOVERY_MARKERS] },
  }
}

function contours(): Record<string, string> {
  return Object.fromEntries(contourSchemaNames().map(name => [name, schemaId(readContourSchema(name))]))
}

export function headCommands(): Record<string, CommandSurface> {
  return commandsOf(main)
}

function ownCommands(commands: Record<string, CommandSurface>): [string, Record<string, Flag>][] {
  return Object.entries(commands).flatMap(([name, command]) => 'flags' in command ? [[name, command.flags] as [string, Record<string, Flag>]] : [])
}

export function refusalCode(command: string, status: number | null): number {
  if (status == null)
    throw new Error(`${command} ${UNDECLARED_FLAG_PROBE} did not exit within ${PROBE_TIMEOUT_MS} ms`)
  return status
}

function refusalOf(cli: ObservedCli, command: string, scratch: string): number {
  const result = spawnSync(process.execPath, cliArgs(cli, [...command.split(' '), UNDECLARED_FLAG_PROBE]), { cwd: scratch, env: cliEnv(scratch), stdio: 'ignore', timeout: PROBE_TIMEOUT_MS })
  return refusalCode(command, result.status)
}

export function unknownFlagRefusals(cli: ObservedCli, commands: Record<string, CommandSurface>): Record<string, number> {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-refusal-')))
  try {
    return Object.fromEntries(ownCommands(commands).map(([name]) => [name, refusalOf(cli, name, scratch)]))
  }
  finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function formsOf(command: string, forms: JsonForms): Set<string> {
  return new Set(Object.entries(forms).filter(([form]) => form === command || form.startsWith(`${command} --`)).flatMap(([, flags]) => flags))
}

function undeclaredFlags(name: string, flags: Record<string, Flag>, recorded: CommandSurface | undefined): string[] {
  if (recorded == null)
    return [`${name}: the command is not declared`]
  if ('aliasOf' in recorded)
    return [`${name}: declared as an alias of ${recorded.aliasOf}, the command line has it as a command`]
  return Object.entries(flags).flatMap(([flag, declared]) => recorded.flags[flag]?.type === declared.type ? [] : [`${name} --${kebab(flag)}: the flag is not declared as ${declared.type}`])
}

function undeclaredForms(name: string, flags: Record<string, Flag>, forms: JsonForms): string[] {
  if (!('json' in flags))
    return []
  const declared = formsOf(name, forms)
  return Object.entries(flags)
    .filter(([flag, declaredFlag]) => declaredFlag.type === 'boolean' && !FLAGS_OF_EVERY_FORM.has(flag) && !declared.has(`--${kebab(flag)}`))
    .map(([flag]) => `${name} --${kebab(flag)} --json: the json form is not declared`)
}

export function undeclared(recorded: Pick<Surface, 'commands' | 'exits' | 'jsonForms' | 'jsonKeys' | 'unknownFlag'>, head: Record<string, CommandSurface>, refusal = FAILED_EXIT): string[] {
  const aliases = Object.entries(head).flatMap(([name, command]) => 'aliasOf' in command && !(name in recorded.commands) ? [`${name}: the alias is not declared`] : [])
  const own = ownCommands(head).flatMap(([name, flags]) => [
    ...undeclaredFlags(name, flags, recorded.commands[name]),
    ...undeclaredForms(name, flags, recorded.jsonForms),
    ...(recorded.exits[name] == null ? [`${name}: the exit codes are not declared`] : []),
    ...(recorded.unknownFlag[name] === refusal ? [] : [`${name} ${UNDECLARED_FLAG_PROBE}: the refusal of an unknown flag is not declared as exit ${refusal}`]),
  ])
  const unsampled = Object.keys(recorded.jsonForms).filter(form => recorded.jsonKeys[form] == null).map(form => `${form}: the json form has no recorded shape`)
  return [...aliases, ...own, ...unsampled]
}

export function generateSurface(): Surface {
  const runs = observedRuns(HEAD_CLI, PRESET_LIST.filter(candidate => candidate.available !== false).map(preset => preset.id))
  const commands = headCommands()
  const json = headJson()
  return {
    surfaceVersion: SURFACE_VERSION,
    commands,
    exits: exitTables(),
    jsonKeys: json.keys,
    jsonForms: json.forms,
    unknownFlag: unknownFlagRefusals(HEAD_CLI, commands),
    formats: runs.formats,
    paths: runs.paths,
    markers: markers(),
    contours: contours(),
    outside: [...OUTSIDE_THE_CONTRACT],
    scripts: scriptSurfaces(),
    report: { ...REPORT_CONTRACT, countLineUnder: [...REPORT_CONTRACT.countLineUnder] },
  }
}

function helpOf(cli: ObservedCli, args: string[], home: string): string {
  return execFileSync(process.execPath, cliArgs(cli, args), { env: cliEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commandsInHelp(cli: ObservedCli, prefix: string[], help: string, home: string): [string, CommandSurface][] {
  return usageCommands(help).flatMap((name) => {
    const words = [...prefix, name]
    const own = helpOf(cli, [...words, '--help'], home)
    return listsCommands(own) ? commandsInHelp(cli, words, own, home) : [[words.join(' '), commandFromHelp(words.join(' '), own)] as [string, CommandSurface]]
  })
}

export function commandsFromHelp(cli: ObservedCli): Record<string, CommandSurface> {
  const home = mkdtempSync(path.join(tmpdir(), 'construct-help-'))
  try {
    return Object.fromEntries(commandsInHelp(cli, [], helpOf(cli, ['--help'], home), home))
  }
  finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function availablePresets(cli: ObservedCli): string[] {
  const listed = JSON.parse(execFileSync(process.execPath, [path.join(cli.root, 'node_modules/tsx/dist/cli.mjs'), '--eval', AVAILABLE_PRESETS], { cwd: cli.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as unknown
  if (!Array.isArray(listed) || !listed.every(id => typeof id === 'string'))
    throw new Error('the tag\'s PRESET_LIST is not a list of presets with ids')
  return listed as string[]
}

function observedOrUnbaselined<T>(what: string, observe: () => T): T | Unbaselined {
  try {
    return observe()
  }
  catch (error) {
    return unbaselined(`${what} could not be observed from the tag: ${failureLine(error)}`)
  }
}

export function tagSurfaceReading(worktree: string): SurfaceReading {
  const cli = tagCli(worktree)
  const runs = observedOrUnbaselined('init and attach', () => observedRuns(cli, availablePresets(cli)))
  const commands = observedOrUnbaselined('--help', () => commandsFromHelp(cli))
  return {
    commands,
    exits: unbaselined(EXITS_NOT_OBSERVABLE),
    jsonKeys: tagJsonKeys(cli),
    jsonForms: unbaselined(JSON_FORMS_NOT_OBSERVABLE),
    unknownFlag: isUnbaselined(commands) ? commands : observedOrUnbaselined('the refusal of an unknown flag', () => unknownFlagRefusals(cli, commands)),
    formats: 'formats' in runs ? runs.formats : runs,
    paths: 'paths' in runs ? runs.paths : runs,
    markers: unbaselined(MARKERS_NOT_OBSERVABLE),
    contours: unbaselined(CONTOURS_NOT_OBSERVABLE),
    outside: unbaselined(OUTSIDE_NOT_OBSERVABLE),
  }
}

function sortedKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(sortedKeys)
  if (value != null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]))
  return value
}

const REPORT_READER_CODE = [
  'export function reportWithoutCountLine(report: string, files: readonly string[]): string | undefined {',
  '  return new RegExp(REPORT_CONTRACT.countLine).test(report) ? undefined : files.find(file => REPORT_CONTRACT.countLineUnder.some(root => file.startsWith(root)))',
  '}',
]

function quoted(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

function reportContractCode(report: ReportContract): string[] {
  const fields = byName(Object.entries(report)).map(([field, value]) => `  ${field}: ${Array.isArray(value) ? `[${value.map(quoted).join(', ')}]` : quoted(value as string | number)},`)
  return ['export const REPORT_CONTRACT = {', ...fields, '} as const', '', ...REPORT_READER_CODE]
}

export function reportContractRefusals(base: ReportContract | undefined, head: ReportContract): string[] {
  if (base === undefined)
    return []
  if (head.reportVersion < base.reportVersion)
    return [`report.reportVersion: ${base.reportVersion} → ${head.reportVersion} goes back`]
  const { reportVersion: _, ...was } = base
  const { reportVersion: __, ...is } = head
  return JSON.stringify(byName(Object.entries(was))) !== JSON.stringify(byName(Object.entries(is))) && head.reportVersion === base.reportVersion
    ? ['report: the report contract changed without its reportVersion growing']
    : []
}

const FORMAT_READER_CODE = [
  'export function formatVersion(file: string, field: ContractFormat): number {',
  `  const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)[field]`,
  `  if (typeof value !== 'number')`,
  `    throw new Error(\`\${file} carries no numeric \${field} that contract/surface.json declares in formats\`)`,
  '  return value',
  '}',
]

function byName<T>(entries: [string, T][]): [string, T][] {
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

export function surfaceBoundaryCode(surface: Pick<Surface, 'surfaceVersion' | 'formats' | 'commands' | 'report'>): string {
  const own = byName(Object.entries(surface.commands)).filter(([, command]) => 'flags' in command).map(([name]) => name)
  return [
    `${GENERATED_SURFACE_FROM}${surface.surfaceVersion}`,
    '',
    'export const CONTRACT_FORMATS = {',
    ...byName(Object.entries(surface.formats)).map(([field, version]) => `  ${field}: ${version},`),
    '} as const',
    '',
    'export type ContractFormat = keyof typeof CONTRACT_FORMATS',
    '',
    'export const CONTRACT_COMMANDS = [',
    ...own.map(name => `  '${name}',`),
    '] as const',
    '',
    'export type ContractCommand = typeof CONTRACT_COMMANDS[number]',
    '',
    ...FORMAT_READER_CODE,
    '',
    ...(surface.report === undefined ? [] : [...reportContractCode(surface.report), '']),
  ].join('\n')
}

export function renderSurface(surface: Surface): string {
  return `${JSON.stringify(sortedKeys(surface as unknown as JsonValue), null, 2)}\n`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.warn(`[contract] ${path.relative(process.cwd(), writeScriptsTable(process.argv[2] ?? REPO_ROOT))}`)
}
