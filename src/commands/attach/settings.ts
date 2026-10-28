import { Buffer } from 'node:buffer'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { appendHookEntry, isJsonObject } from '../../materialize/strategies.js'
import { engramFile } from '../../model/discovery.js'
import { ATTACH_GUARD, ATTACH_WINDOW_HOOKS } from '../../presets/index.js'
import { sha256OfBytes } from './original.js'

type JsonObject = Record<string, unknown>

export const SETTINGS_FILE = '.claude/settings.local.json'

const GUARD_TIMEOUT_SECONDS = 30

export const GUARD_ENTRY: JsonObject = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/${ATTACH_GUARD.target}`, timeout: GUARD_TIMEOUT_SECONDS }],
}

const WINDOW_HOOK_TIMEOUT_SECONDS = 10

export const WINDOW_EVENTS = ['Stop', 'PreCompact', 'SessionStart', 'PreToolUse'] as const

export type WindowEvent = typeof WINDOW_EVENTS[number]

type HookEvent = WindowEvent

const HOOK_EVENTS: readonly HookEvent[] = WINDOW_EVENTS

function windowHook(argument: string): JsonObject {
  return { type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/${ATTACH_WINDOW_HOOKS.target} ${argument}`, timeout: WINDOW_HOOK_TIMEOUT_SECONDS }
}

export const WINDOW_ENTRIES: Readonly<Record<WindowEvent, JsonObject>> = {
  Stop: { hooks: [windowHook('stop')] },
  PreCompact: { hooks: [windowHook('pre-compact')] },
  SessionStart: { hooks: [windowHook('session-start')] },
  PreToolUse: { matcher: 'Write|Edit|MultiEdit', hooks: [windowHook('pre-tool-use')] },
}

export interface WindowEntry {
  event: WindowEvent
  entry: JsonObject
  created: boolean
}

export interface SettingsCreated {
  file: boolean
  hooks: boolean
  preToolUse: boolean
}

export interface EngramPermissions {
  added: string[]
  createdPermissions: boolean
  createdAllow: boolean
}

export interface SandboxExclusion {
  added: string[]
  createdSandbox: boolean
  createdExcluded: boolean
}

export const BROWSER_LAB_EXCLUDED_COMMAND = 'node scripts/construct/browser-lab.mjs *'

const ENGRAM_TOOLS = ['Read', 'Edit'] as const

export function engramRules(root: string, home: string = homedir()): string[] {
  const directory = path.dirname(engramFile(root, { attached: true, home }))
  return ENGRAM_TOOLS.map(tool => `${tool}(/${directory}/**)`)
}

export interface SettingsOriginal {
  copy: string
  sha256: string
  afterSha256: string
}

export interface SettingsHook {
  file: string
  created: SettingsCreated
  entry: JsonObject
  window?: WindowEntry[]
  engram?: EngramPermissions
  sandbox?: SandboxExclusion
  original?: SettingsOriginal
}

interface RecordedEntry {
  event: HookEvent
  entry: JsonObject
  created: boolean
  target: string
}

function recordedEntries(hook: SettingsHook): RecordedEntry[] {
  const guard: RecordedEntry = { event: 'PreToolUse', entry: hook.entry, created: hook.created.preToolUse, target: ATTACH_GUARD.target }
  return [guard, ...(hook.window ?? []).map(window => ({ ...window, target: ATTACH_WINDOW_HOOKS.target }))]
}

export type SettingsReading
  = | { kind: 'absent' }
    | { kind: 'unreadable' }
    | { kind: 'read', settings: JsonObject, bytes: Buffer }

export function settingsExist(root: string): boolean {
  try {
    lstatSync(path.join(root, SETTINGS_FILE))
    return true
  }
  catch {
    return false
  }
}

export function readSettings(root: string): SettingsReading {
  const file = path.join(root, SETTINGS_FILE)
  if (!settingsExist(root))
    return { kind: 'absent' }
  if (!lstatSync(file).isFile())
    return { kind: 'unreadable' }
  const bytes = readFileSync(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  }
  catch {
    return { kind: 'unreadable' }
  }
  if (!isJsonObject(parsed))
    return { kind: 'unreadable' }
  if ('hooks' in parsed && !isJsonObject(parsed.hooks))
    return { kind: 'unreadable' }
  if ('permissions' in parsed && !isJsonObject(parsed.permissions))
    return { kind: 'unreadable' }
  if (isJsonObject(parsed.permissions) && 'allow' in parsed.permissions && !Array.isArray(parsed.permissions.allow))
    return { kind: 'unreadable' }
  if ('sandbox' in parsed && !isJsonObject(parsed.sandbox))
    return { kind: 'unreadable' }
  if (isJsonObject(parsed.sandbox) && 'excludedCommands' in parsed.sandbox && !Array.isArray(parsed.sandbox.excludedCommands))
    return { kind: 'unreadable' }
  const hooks = parsed.hooks
  if (isJsonObject(hooks) && HOOK_EVENTS.some(event => event in hooks && !Array.isArray(hooks[event])))
    return { kind: 'unreadable' }
  return { kind: 'read', settings: parsed, bytes }
}

function names(element: unknown, target: string): boolean {
  if (!isJsonObject(element) || !Array.isArray(element.hooks))
    return false
  return element.hooks.some(hook => isJsonObject(hook) && typeof hook.command === 'string' && hook.command.includes(target))
}

export function namesGuard(element: unknown): boolean {
  return names(element, ATTACH_GUARD.target)
}

function entriesOf(settings: JsonObject, event: HookEvent): unknown[] {
  const hooks = settings.hooks
  return isJsonObject(hooks) && Array.isArray(hooks[event]) ? hooks[event] : []
}

export function carriesGuardEntry(settings: JsonObject): boolean {
  return entriesOf(settings, 'PreToolUse').some(namesGuard)
}

function carriesWindowEntry(settings: JsonObject): boolean {
  return WINDOW_EVENTS.some(event => entriesOf(settings, event).some(element => names(element, ATTACH_WINDOW_HOOKS.target)))
}

export function writeSettingsBytes(root: string, bytes: Buffer): void {
  const file = path.join(root, SETTINGS_FILE)
  const temporary = path.join(path.dirname(file), `.settings.local.json.${process.pid}.tmp`)
  mkdirSync(path.dirname(file), { recursive: true })
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' })
    if (existsSync(file))
      chmodSync(temporary, statSync(file).mode & 0o777)
    renameSync(temporary, file)
  }
  catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function writeSettings(root: string, settings: JsonObject): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`)
  writeSettingsBytes(root, bytes)
  return bytes
}

function allowEngram(settings: JsonObject, rules: string[]): EngramPermissions {
  const createdPermissions = !('permissions' in settings)
  const permissions: JsonObject = isJsonObject(settings.permissions) ? settings.permissions : {}
  const createdAllow = !('allow' in permissions)
  const allow: unknown[] = Array.isArray(permissions.allow) ? permissions.allow : []
  const added = rules.filter(rule => !allow.includes(rule))
  allow.push(...added)
  permissions.allow = allow
  settings.permissions = permissions
  return { added, createdPermissions, createdAllow }
}

function revokeEngram(settings: JsonObject, engram: EngramPermissions): void {
  const permissions = settings.permissions
  if (!isJsonObject(permissions) || !Array.isArray(permissions.allow))
    return
  const remaining = permissions.allow.filter(rule => !engram.added.includes(rule as string))
  permissions.allow = remaining
  if (engram.createdAllow && remaining.length === 0)
    delete permissions.allow
  if (engram.createdPermissions && Object.keys(permissions).length === 0)
    delete settings.permissions
}

function excludeBrowserLab(settings: JsonObject): SandboxExclusion {
  const createdSandbox = !('sandbox' in settings)
  const sandbox: JsonObject = isJsonObject(settings.sandbox) ? settings.sandbox : {}
  const createdExcluded = !('excludedCommands' in sandbox)
  const excluded: unknown[] = Array.isArray(sandbox.excludedCommands) ? sandbox.excludedCommands : []
  const added = excluded.includes(BROWSER_LAB_EXCLUDED_COMMAND) ? [] : [BROWSER_LAB_EXCLUDED_COMMAND]
  excluded.push(...added)
  sandbox.excludedCommands = excluded
  settings.sandbox = sandbox
  return { added, createdSandbox, createdExcluded }
}

function restoreSandbox(settings: JsonObject, exclusion: SandboxExclusion): void {
  const sandbox = settings.sandbox
  if (!isJsonObject(sandbox) || !Array.isArray(sandbox.excludedCommands))
    return
  const remaining = sandbox.excludedCommands.filter(command => !exclusion.added.includes(command as string))
  sandbox.excludedCommands = remaining
  if (exclusion.createdExcluded && remaining.length === 0)
    delete sandbox.excludedCommands
  if (exclusion.createdSandbox && Object.keys(sandbox).length === 0)
    delete settings.sandbox
}

function isSandboxRecord(value: unknown): boolean {
  return value === undefined || (isJsonObject(value) && Array.isArray(value.added) && value.added.every(command => command === BROWSER_LAB_EXCLUDED_COMMAND) && typeof value.createdSandbox === 'boolean' && typeof value.createdExcluded === 'boolean')
}

function isEngramRecord(value: unknown): boolean {
  return value === undefined || (isJsonObject(value) && Array.isArray(value.added) && value.added.every(rule => typeof rule === 'string') && typeof value.createdPermissions === 'boolean' && typeof value.createdAllow === 'boolean')
}

export type SettingsInstall
  = | { kind: 'installed', hook: SettingsHook, afterSha256: string }
    | { kind: 'unreadable' }
    | { kind: 'guarded' }

export function installHookEntries(root: string, reading: SettingsReading): SettingsInstall {
  if (reading.kind === 'unreadable')
    return { kind: 'unreadable' }
  const settings: JsonObject = reading.kind === 'read' ? reading.settings : {}
  if (carriesGuardEntry(settings) || carriesWindowEntry(settings))
    return { kind: 'guarded' }
  const hooks: JsonObject = isJsonObject(settings.hooks) ? settings.hooks : {}
  const createdHooks = !('hooks' in settings)
  const entry = structuredClone(GUARD_ENTRY)
  const created: SettingsCreated = { file: reading.kind === 'absent', hooks: createdHooks, preToolUse: appendHookEntry(hooks, 'PreToolUse', entry) }
  const window = WINDOW_EVENTS.map((event) => {
    const windowEntry = structuredClone(WINDOW_ENTRIES[event])
    return { event, entry: windowEntry, created: appendHookEntry(hooks, event, windowEntry) }
  })
  settings.hooks = hooks
  const engram = allowEngram(settings, engramRules(root))
  const sandbox = excludeBrowserLab(settings)
  const afterSha256 = sha256OfBytes(writeSettings(root, settings))
  return { kind: 'installed', hook: { file: SETTINGS_FILE, created, entry, window, engram, sandbox }, afterSha256 }
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function isSettingsOriginal(value: unknown): value is SettingsOriginal {
  if (!isJsonObject(value))
    return false
  const { copy, sha256: original, afterSha256 } = value
  return typeof copy === 'string' && path.isAbsolute(copy) && [original, afterSha256].every(hash => typeof hash === 'string' && SHA256_HEX.test(hash))
}

function isWindowEntry(value: unknown): value is WindowEntry {
  return isJsonObject(value)
    && (WINDOW_EVENTS as readonly unknown[]).includes(value.event)
    && typeof value.created === 'boolean'
    && names(value.entry, ATTACH_WINDOW_HOOKS.target)
}

function isWindowRecord(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isWindowEntry) && new Set(value.map(entry => entry.event)).size === value.length)
}

export function isSettingsHook(value: unknown): value is SettingsHook {
  if (!isJsonObject(value) || value.file !== SETTINGS_FILE || !isJsonObject(value.created))
    return false
  const { file, hooks, preToolUse } = value.created
  if (![file, hooks, preToolUse].every(flag => typeof flag === 'boolean') || !isJsonObject(value.entry) || !namesGuard(value.entry) || !isWindowRecord(value.window) || !isEngramRecord(value.engram) || !isSandboxRecord(value.sandbox))
    return false
  return value.original === undefined || (file === false && isSettingsOriginal(value.original))
}

export type EntryClass = 'adopted' | 'absent' | 'unreadable' | 'changed' | 'remove'

export function classifyEntry(root: string, hook: SettingsHook, tracked: Set<string>): EntryClass {
  if (tracked.has(SETTINGS_FILE))
    return 'adopted'
  const reading = readSettings(root)
  if (reading.kind === 'absent')
    return 'absent'
  if (reading.kind === 'unreadable')
    return 'unreadable'
  const settings = reading.settings
  const named = recordedEntries(hook).map(recorded => ({ recorded, found: entriesOf(settings, recorded.event).filter(element => names(element, recorded.target)) }))
  if (named.every(({ found }) => found.length === 0))
    return 'absent'
  return named.every(({ recorded, found }) => found.every(element => isDeepStrictEqual(element, recorded.entry))) ? 'remove' : 'changed'
}

export function removeHookEntries(root: string, hook: SettingsHook): { fileDeleted: boolean } {
  const reading = readSettings(root)
  if (reading.kind !== 'read' || !isJsonObject(reading.settings.hooks))
    throw new Error(`${SETTINGS_FILE} changed while detach ran`)
  const settings = reading.settings
  const hooks = reading.settings.hooks
  const recorded = recordedEntries(hook)
  for (const { event, entry } of recorded) {
    if (!(event in hooks))
      continue
    hooks[event] = entriesOf(settings, event).filter(element => !isDeepStrictEqual(element, entry))
  }
  for (const event of new Set(recorded.map(entry => entry.event))) {
    if (event in hooks && Array.isArray(hooks[event]) && hooks[event].length === 0 && recorded.some(entry => entry.event === event && entry.created))
      delete hooks[event]
  }
  if (hook.engram != null)
    revokeEngram(settings, hook.engram)
  if (hook.sandbox != null)
    restoreSandbox(settings, hook.sandbox)
  if (hook.created.hooks && Object.keys(hooks).length === 0)
    delete settings.hooks
  if (hook.created.file && Object.keys(settings).length === 0) {
    rmSync(path.join(root, SETTINGS_FILE))
    return { fileDeleted: true }
  }
  writeSettings(root, settings)
  return { fileDeleted: false }
}
