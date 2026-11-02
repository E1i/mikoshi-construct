import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { busPathOf, constructHome, DECISIONS_FILE, decisionsFileOf, isOwnerCheckout, repoHome, repoIdOf } from '../../../scripts/core/bus-path.js'
import { inForce, parseDecisions } from '../../../scripts/policy/decisions/decisions.js'
import { namesQueueLive } from '../../../scripts/policy/live-decision.js'
import { readManifest, recordedShas } from '../../manifest.js'
import { FACTORY_MANIFEST } from '../../materialize/factory-manifest.js'
import { MIKOSHI_PNPM, pinnedPnpm } from '../../presets/index.js'
import { factoryLiveness } from '../liveness.js'
import { FileReadings } from './readings.js'

export const FACTORY_SLICES = ['PARITY', 'ONEWORD'] as const
export type FactorySlice = typeof FACTORY_SLICES[number]

export const FACTORY_ITEMS = {
  'factory-files': 'PARITY',
  'factory-hooks': 'PARITY',
  'pnpm-floor': 'PARITY',
  'pnpm-store-ignored': 'PARITY',
  'card-permissions': 'PARITY',
  'window-live': 'PARITY',
  'window-continue': 'ONEWORD',
  'live-merge': 'ONEWORD',
  'live-update': 'ONEWORD',
} as const satisfies Record<string, FactorySlice>
export type FactoryItemName = keyof typeof FACTORY_ITEMS

export const SYNC_APPLY = 'construct sync --apply'
export const RESTORE_FROM_GIT = 'git restore --'
export const PIN_PNPM_FLOOR = `corepack use pnpm@${MIKOSHI_PNPM}`
export const IGNORE_PNPM_STORE = `printf '.pnpm-store/\\n' >> .gitignore`
export const OPEN_A_WINDOW = 'claude'
export const EDIT_LOCAL_SETTINGS = '$EDITOR .claude/settings.local.json'
export const GHOST_PROTOCOL_HOURS = 6
export const OWNER_WORD = `ghost-protocol ${GHOST_PROTOCOL_HOURS}h`
export const SWITCH_TO_GHOST_PROTOCOL = `construct say "${OWNER_WORD}" && construct-factory --mode ghost-protocol`

const SETTINGS = '.claude/settings.json'
const LOCAL_SETTINGS = '.claude/settings.local.json'
const WIDENING_PERMISSIONS = ['allow', 'additionalDirectories', 'defaultMode'] as const
const WINDOW_HANDOFF = 'miko.md'
const HANDOFF_VARIABLE = 'CONSTRUCT_HANDOFF'
const HANDOFF_DIR_VARIABLE = 'CONSTRUCT_HANDOFF_DIR'
const HANDOFF_DIR = 'handoff'
const STATUS_LINE = /^STATUS:\s*(CONTINUE|OWNER|DONE|STOP)\b/
const CONTINUE = 'CONTINUE'
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

function present(value: unknown): boolean {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)
}

function widensCardSessions(readings: FileReadings): boolean {
  const local = readings.readJson(LOCAL_SETTINGS)
  if (local === null)
    return readings.unreadable(LOCAL_SETTINGS)
  const permissions = (local.permissions ?? {}) as Record<string, unknown>
  return local.sandbox !== undefined || WIDENING_PERMISSIONS.some(key => present(permissions[key]))
}

function named(env: NodeJS.ProcessEnv, variable: string): string | null {
  const value = env[variable]
  return value === undefined || value === '' ? null : value
}

function windowHandoffOf(situation: FactorySituation, root: string): string {
  const handoffs = named(situation.env, HANDOFF_DIR_VARIABLE) ?? path.join(isOwnerCheckout(root) ? constructHome(situation.home) : repoHome(situation.home, repoIdOf(root)), HANDOFF_DIR)
  return named(situation.env, HANDOFF_VARIABLE) ?? path.join(handoffs, WINDOW_HANDOFF)
}

function lastStatus(handoff: string): string | null {
  const text = new FileReadings(path.dirname(handoff)).read(path.basename(handoff)) ?? ''
  return text.split(/\r?\n/).flatMap(line => STATUS_LINE.exec(line)?.[1] ?? []).at(-1) ?? null
}

function writeContinueCommand(root: string, handoff: string): string {
  return `${isOwnerCheckout(root) ? 'pnpm handoff:write' : 'miko handoff write'} ${handoff} <draft ending STATUS: ${CONTINUE}>`
}

function liveQueues(decisionsFile: string, now: Date): (queue: string) => boolean {
  const decisions = inForce(parseDecisions(new FileReadings(path.dirname(decisionsFile)).read(DECISIONS_FILE) ?? '').decisions, now)
  return queue => decisions.some(decision => namesQueueLive(decision.body, queue))
}

function factoryFilesCommand(root: string, missing: readonly string[]): string {
  const manifest = readManifest(root)
  const recorded = manifest == null ? {} : recordedShas(manifest)
  const lost = missing.filter(file => recorded[file] != null)
  const restore = `${RESTORE_FROM_GIT} ${lost.join(' ')}`
  if (lost.length === 0)
    return SYNC_APPLY
  return lost.length === missing.length ? restore : `${restore} && ${SYNC_APPLY}`
}

function item(name: FactoryItemName, goes: boolean, command: string): FactoryItem {
  return { item: name, slice: FACTORY_ITEMS[name], goes, command: goes ? null : command }
}

export function factoryChecklist(root: string, situation: FactorySituation = { env: process.env, home: homedir(), now: new Date() }): FactoryChecklist {
  const readings = new FileReadings(root)
  const bus = busPathOf(situation.env, situation.home, root, isOwnerCheckout(root))
  const live = liveQueues(decisionsFileOf(bus), situation.now)
  const handoff = windowHandoffOf(situation, root)
  const missing = FACTORY_MANIFEST.filter(file => readings.read(file) === null)
  const items = [
    item('factory-files', missing.length === 0, factoryFilesCommand(root, missing)),
    item('factory-hooks', carriesFactoryHooks(readings), SYNC_APPLY),
    item('pnpm-floor', pnpmAtTheFloor(readings), PIN_PNPM_FLOOR),
    item('pnpm-store-ignored', ignoresPnpmStore(readings), IGNORE_PNPM_STORE),
    item('card-permissions', !widensCardSessions(readings), EDIT_LOCAL_SETTINGS),
    item('window-live', factoryLiveness(bus, situation.now.getTime()).state === 'live', OPEN_A_WINDOW),
    item('window-continue', lastStatus(handoff) === CONTINUE, writeContinueCommand(root, handoff)),
    item('live-merge', live('merge'), SWITCH_TO_GHOST_PROTOCOL),
    item('live-update', live('update'), SWITCH_TO_GHOST_PROTOCOL),
  ]
  return { goes: items.every(entry => entry.goes), bus, items }
}
