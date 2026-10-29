import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { busPathOf, DECISIONS_FILE, decisionsFileOf, isOwnerCheckout } from '../../../scripts/core/bus-path.js'
import { readManifest, recordedShas } from '../../manifest.js'
import { FACTORY_MANIFEST } from '../../materialize/factory-manifest.js'
import { MIKOSHI_PNPM, pinnedPnpm } from '../../presets/index.js'
import { factoryLiveness } from '../liveness.js'
import { liveQueuesIn } from './live-decisions.js'
import { FileReadings } from './readings.js'

export const FACTORY_SLICES = ['PARITY', 'ONEWORD'] as const
export type FactorySlice = typeof FACTORY_SLICES[number]

export const FACTORY_ITEMS = {
  'factory-files': 'PARITY',
  'factory-hooks': 'PARITY',
  'pnpm-floor': 'PARITY',
  'pnpm-store-ignored': 'PARITY',
  'window-live': 'PARITY',
  'live-merge': 'ONEWORD',
  'live-update': 'ONEWORD',
} as const satisfies Record<string, FactorySlice>
export type FactoryItemName = keyof typeof FACTORY_ITEMS

export const SYNC_APPLY = 'construct sync --apply'
export const RESTORE_FROM_GIT = 'git restore --'
export const PIN_PNPM_FLOOR = `corepack use pnpm@${MIKOSHI_PNPM}`
export const IGNORE_PNPM_STORE = `printf '.pnpm-store/\\n' >> .gitignore`
export const OPEN_A_WINDOW = 'claude'
export const GHOST_PROTOCOL_HOURS = 6
export const OWNER_WORD = `ghost-protocol ${GHOST_PROTOCOL_HOURS}h`
export const SWITCH_TO_GHOST_PROTOCOL = `construct say "${OWNER_WORD}" && construct-factory --mode ghost-protocol`

const SETTINGS = '.claude/settings.json'
const PNPM_STORE_LINE = '.pnpm-store/'
const PNPM_PIN = /^pnpm@(\d+\.\d+\.\d+)/

const FACTORY_HOOKS = [
  { event: 'PreToolUse', command: 'scripts/construct/eddies.mjs guard' },
  { event: 'UserPromptSubmit', command: 'scripts/construct/eddies.mjs prompt' },
  { event: 'PostToolUse', command: 'scripts/construct/window-heartbeat.mjs' },
] as const

export interface FactoryItem {
  item: FactoryItemName
  slice: FactorySlice
  goes: boolean
  command: string | null
}

export interface FactoryChecklist {
  goes: boolean
  bus: string
  items: FactoryItem[]
}

export interface FactorySituation {
  env: NodeJS.ProcessEnv
  home: string
  now: Date
}

interface HookEntry { hooks?: { command?: unknown }[] }

function hookCommands(settings: Record<string, unknown> | null, event: string): string[] {
  const hooks = settings?.hooks as Record<string, HookEntry[] | undefined> | undefined
  const entries = hooks?.[event]
  if (!Array.isArray(entries))
    return []
  return entries.flatMap(entry => (entry.hooks ?? []).map(hook => hook.command).filter(command => typeof command === 'string'))
}

function carriesFactoryHooks(readings: FileReadings): boolean {
  const settings = readings.readJson(SETTINGS)
  return FACTORY_HOOKS.every(hook => hookCommands(settings, hook.event).some(command => command.endsWith(hook.command)))
}

function pnpmAtTheFloor(readings: FileReadings): boolean {
  const pinned = readings.readJson('package.json')?.packageManager
  const version = typeof pinned === 'string' ? PNPM_PIN.exec(pinned)?.[1] : undefined
  return version !== undefined && pinnedPnpm(version) === version
}

function ignoresPnpmStore(readings: FileReadings): boolean {
  return (readings.read('.gitignore') ?? '').split(/\r?\n/).some(line => line.trim() === PNPM_STORE_LINE)
}

function liveQueues(decisionsFile: string, now: Date): (queue: string) => boolean {
  const live = liveQueuesIn(new FileReadings(path.dirname(decisionsFile)).read(DECISIONS_FILE) ?? '', now)
  return queue => live.has(queue)
}

function factoryFilesCommand(root: string, missing: readonly string[]): string {
  const manifest = readManifest(root)
  const recorded = manifest == null ? {} : recordedShas(manifest)
  const lost = missing.filter(file => recorded[file] != null)
  return lost.length === 0 ? SYNC_APPLY : `${RESTORE_FROM_GIT} ${lost.join(' ')}`
}

function item(name: FactoryItemName, goes: boolean, command: string): FactoryItem {
  return { item: name, slice: FACTORY_ITEMS[name], goes, command: goes ? null : command }
}

export function factoryChecklist(root: string, situation: FactorySituation = { env: process.env, home: homedir(), now: new Date() }): FactoryChecklist {
  const readings = new FileReadings(root)
  const bus = busPathOf(situation.env, situation.home, root, isOwnerCheckout(root))
  const live = liveQueues(decisionsFileOf(bus), situation.now)
  const missing = FACTORY_MANIFEST.filter(file => readings.read(file) === null)
  const items = [
    item('factory-files', missing.length === 0, factoryFilesCommand(root, missing)),
    item('factory-hooks', carriesFactoryHooks(readings), SYNC_APPLY),
    item('pnpm-floor', pnpmAtTheFloor(readings), PIN_PNPM_FLOOR),
    item('pnpm-store-ignored', ignoresPnpmStore(readings), IGNORE_PNPM_STORE),
    item('window-live', factoryLiveness(bus, situation.now.getTime()).state === 'live', OPEN_A_WINDOW),
    item('live-merge', live('merge'), SWITCH_TO_GHOST_PROTOCOL),
    item('live-update', live('update'), SWITCH_TO_GHOST_PROTOCOL),
  ]
  return { goes: items.every(entry => entry.goes), bus, items }
}
