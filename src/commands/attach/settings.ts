import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { isJsonObject } from '../../materialize/strategies.js'
import { ATTACH_GUARD } from '../../presets/index.js'

type JsonObject = Record<string, unknown>

export const SETTINGS_FILE = '.claude/settings.local.json'

const GUARD_TIMEOUT_SECONDS = 30

export const GUARD_ENTRY: JsonObject = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/${ATTACH_GUARD.target}`, timeout: GUARD_TIMEOUT_SECONDS }],
}

export interface SettingsCreated {
  file: boolean
  hooks: boolean
  preToolUse: boolean
}

export interface SettingsHook {
  file: string
  created: SettingsCreated
  entry: JsonObject
}

export type SettingsReading
  = | { kind: 'absent' }
    | { kind: 'unreadable' }
    | { kind: 'read', settings: JsonObject }

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
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch {
    return { kind: 'unreadable' }
  }
  if (!isJsonObject(parsed))
    return { kind: 'unreadable' }
  if ('hooks' in parsed && !isJsonObject(parsed.hooks))
    return { kind: 'unreadable' }
  if (isJsonObject(parsed.hooks) && 'PreToolUse' in parsed.hooks && !Array.isArray(parsed.hooks.PreToolUse))
    return { kind: 'unreadable' }
  return { kind: 'read', settings: parsed }
}

export function namesGuard(element: unknown): boolean {
  if (!isJsonObject(element) || !Array.isArray(element.hooks))
    return false
  return element.hooks.some(hook => isJsonObject(hook) && typeof hook.command === 'string' && hook.command.includes(ATTACH_GUARD.target))
}

function preToolUseOf(settings: JsonObject): unknown[] {
  const hooks = settings.hooks
  return isJsonObject(hooks) && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
}

export function carriesGuardEntry(settings: JsonObject): boolean {
  return preToolUseOf(settings).some(namesGuard)
}

function writeSettings(root: string, settings: JsonObject): void {
  const file = path.join(root, SETTINGS_FILE)
  const temporary = path.join(path.dirname(file), `.settings.local.json.${process.pid}.tmp`)
  mkdirSync(path.dirname(file), { recursive: true })
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' })
    if (existsSync(file))
      chmodSync(temporary, statSync(file).mode & 0o777)
    renameSync(temporary, file)
  }
  catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export type SettingsInstall
  = | { kind: 'installed', hook: SettingsHook }
    | { kind: 'unreadable' }
    | { kind: 'guarded' }

export function installGuardEntry(root: string): SettingsInstall {
  const reading = readSettings(root)
  if (reading.kind === 'unreadable')
    return { kind: 'unreadable' }
  const settings: JsonObject = reading.kind === 'read' ? reading.settings : {}
  const hooks: JsonObject = isJsonObject(settings.hooks) ? settings.hooks : {}
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  if (existing.some(namesGuard))
    return { kind: 'guarded' }
  const created: SettingsCreated = {
    file: reading.kind === 'absent',
    hooks: !('hooks' in settings),
    preToolUse: !('PreToolUse' in hooks),
  }
  const entry = structuredClone(GUARD_ENTRY)
  hooks.PreToolUse = [...existing, entry]
  settings.hooks = hooks
  writeSettings(root, settings)
  return { kind: 'installed', hook: { file: SETTINGS_FILE, created, entry } }
}

export function isSettingsHook(value: unknown): value is SettingsHook {
  if (!isJsonObject(value) || value.file !== SETTINGS_FILE || !isJsonObject(value.created))
    return false
  const { file, hooks, preToolUse } = value.created
  return [file, hooks, preToolUse].every(flag => typeof flag === 'boolean') && isJsonObject(value.entry) && namesGuard(value.entry)
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
  const named = preToolUseOf(reading.settings).filter(namesGuard)
  if (named.length === 0)
    return 'absent'
  return named.every(element => isDeepStrictEqual(element, hook.entry)) ? 'remove' : 'changed'
}

export function removeGuardEntry(root: string, hook: SettingsHook): { fileDeleted: boolean } {
  const reading = readSettings(root)
  if (reading.kind !== 'read')
    throw new Error(`${SETTINGS_FILE} changed while detach ran`)
  const settings = reading.settings
  const hooks = settings.hooks as JsonObject
  const remaining = preToolUseOf(settings).filter(element => !isDeepStrictEqual(element, hook.entry))
  hooks.PreToolUse = remaining
  if (hook.created.preToolUse && remaining.length === 0)
    delete hooks.PreToolUse
  if (hook.created.hooks && Object.keys(hooks).length === 0)
    delete settings.hooks
  if (hook.created.file && Object.keys(settings).length === 0) {
    rmSync(path.join(root, SETTINGS_FILE))
    return { fileDeleted: true }
  }
  writeSettings(root, settings)
  return { fileDeleted: false }
}
