import type { ArgsDef, CommandDef } from 'citty'
import type { JsonKeys, ObservedCli } from './json-samples.js'
import type { SurfaceReading, Unbaselined } from './semantic-diff.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ATTACH_EXIT } from '../../src/commands/attach/index.js'
import { COST_EXIT } from '../../src/commands/cost/index.js'
import { DETACH_EXIT } from '../../src/commands/detach/index.js'
import { DOCTOR_EXIT } from '../../src/commands/doctor/index.js'
import { GRAPH_EXIT } from '../../src/commands/graph.js'
import { INIT_EXIT } from '../../src/commands/init.js'
import { SOULKILL_EXIT } from '../../src/commands/soulkill.js'
import { SYNC_APPLY_EXIT, SYNC_EXIT } from '../../src/commands/sync/index.js'
import { FAILED_EXIT } from '../../src/failure.js'
import { DISCOVERY_MARKERS } from '../../src/manifest.js'
import { blockMarkers, discoveryTags } from '../../src/materialize/strategies.js'
import { PRESET_LIST } from '../../src/presets/index.js'
import { main } from '../../src/program.js'
import { commandFromHelp, usageCommands } from './help.js'
import { cliArgs, cliEnv, failureLine, HEAD_CLI, jsonKeys, tagCli, tagJsonKeys } from './json-samples.js'
import { unbaselined } from './semantic-diff.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const ATTACH_SAMPLE = path.join(REPO_ROOT, 'tests/fixtures/existing-monorepo')
const GIT_EXCLUDE = '.git/info/exclude'
const EXITS_NOT_OBSERVABLE = 'exit codes are not observable from the tag\'s output'
const MARKERS_NOT_OBSERVABLE = 'block and discovery markers are read from the source\'s exports, not from the tag\'s output'
const OUTSIDE_NOT_OBSERVABLE = 'what lies outside the contract is a recorded decision, not an output of the tag'
const AVAILABLE_PRESETS = 'import(\'./src/presets/index.ts\').then(m => console.log(JSON.stringify(m.PRESET_LIST.filter(p => p.available !== false).map(p => p.id))))'

export const SURFACE_VERSION = 2

export const OUTSIDE_THE_CONTRACT = [
  '.construct/runs.jsonl',
  'graph --out HTML',
  'human-readable output text',
  'lore strings',
]

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface Flag {
  type: string
  alias?: string
}

export type CommandSurface = { flags: Record<string, Flag> } | { aliasOf: string }

export interface Surface {
  surfaceVersion: number
  commands: Record<string, CommandSurface>
  exits: Record<string, Record<string, number>>
  jsonKeys: JsonKeys
  formats: { manifestVersion: number, modelVersion: number, recordVersion: number }
  paths: { init: Record<string, string[]>, attach: { writes: string[], edits: string[] } }
  markers: { block: string[][], discover: { tags: string[], markers: string[] } }
  outside: string[]
}

function commandsOf(root: CommandDef): Record<string, CommandSurface> {
  const subCommands = root.subCommands
  if (subCommands == null || typeof subCommands !== 'object')
    throw new Error('main.subCommands is not a plain object')
  const firstName = new Map<unknown, string>()
  const commands: Record<string, CommandSurface> = {}
  for (const [name, command] of Object.entries(subCommands)) {
    const target = firstName.get(command)
    if (target != null) {
      commands[name] = { aliasOf: target }
      continue
    }
    firstName.set(command, name)
    commands[name] = { flags: flagsOf((command as CommandDef).args) }
  }
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
    return [name, alias == null ? { type: String(arg.type ?? 'string') } : { type: String(arg.type ?? 'string'), alias }]
  }))
}

function withFailed(table: Record<string, number>): Record<string, number> {
  return { ...table, failed: FAILED_EXIT }
}

function exits(): Record<string, Record<string, number>> {
  return {
    'init': withFailed(INIT_EXIT),
    'attach': withFailed(ATTACH_EXIT),
    'detach': withFailed(DETACH_EXIT),
    'soulkill': withFailed(SOULKILL_EXIT),
    'doctor': withFailed(DOCTOR_EXIT),
    'sync': withFailed(SYNC_EXIT),
    'sync --apply': withFailed(SYNC_APPLY_EXIT),
    'cost': withFailed(COST_EXIT),
    'graph': withFailed(GRAPH_EXIT),
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

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

function versionField(file: string, field: string): number {
  const value = readJson(file)[field]
  if (typeof value !== 'number')
    throw new Error(`${file} carries no numeric ${field}`)
  return value
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
    execFileSync('git', ['init', '-q'], { cwd: repository })
    const before = new Set(filesUnder(repository))
    runCli(cli, ['attach', '--yes', '--harness', 'pnpm run quality'], repository, home)
    const writes = filesUnder(repository).filter(file => !before.has(file)).sort()

    return {
      formats: {
        manifestVersion: versionField(path.join(initialised, 'construct.json'), 'manifestVersion'),
        modelVersion: versionField(path.join(initialised, 'construct.model.json'), 'modelVersion'),
        recordVersion: versionField(path.join(repository, '.construct/attach.json'), 'recordVersion'),
      },
      paths: { init, attach: { writes, edits: [GIT_EXCLUDE] } },
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

export function headCommands(): Record<string, CommandSurface> {
  return commandsOf(main)
}

export function generateSurface(): Surface {
  const runs = observedRuns(HEAD_CLI, PRESET_LIST.filter(candidate => candidate.available !== false).map(preset => preset.id))
  return {
    surfaceVersion: SURFACE_VERSION,
    commands: headCommands(),
    exits: exits(),
    jsonKeys: jsonKeys(),
    formats: runs.formats,
    paths: runs.paths,
    markers: markers(),
    outside: [...OUTSIDE_THE_CONTRACT],
  }
}

function helpOf(cli: ObservedCli, args: string[], home: string): string {
  return execFileSync(process.execPath, cliArgs(cli, args), { env: cliEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function commandsFromHelp(cli: ObservedCli): Record<string, CommandSurface> {
  const home = mkdtempSync(path.join(tmpdir(), 'construct-help-'))
  try {
    return Object.fromEntries(usageCommands(helpOf(cli, ['--help'], home)).map(name => [name, commandFromHelp(name, helpOf(cli, [name, '--help'], home))]))
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
  return {
    commands: observedOrUnbaselined('--help', () => commandsFromHelp(cli)),
    exits: unbaselined(EXITS_NOT_OBSERVABLE),
    jsonKeys: tagJsonKeys(cli),
    formats: 'formats' in runs ? runs.formats : runs,
    paths: 'paths' in runs ? runs.paths : runs,
    markers: unbaselined(MARKERS_NOT_OBSERVABLE),
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

export function renderSurface(surface: Surface): string {
  return `${JSON.stringify(sortedKeys(surface as unknown as JsonValue), null, 2)}\n`
}
