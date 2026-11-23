import { Buffer } from 'node:buffer'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { appendHookEntry, isJsonObject } from '../../materialize/strategies.js'
import { engramFile } from '../../model/discovery.js'
import { ATTACH_GUARD, ATTACH_WINDOW_HOOKS } from '../../presets/index.js'
import { readTrackedPaths } from '../detach/index-reader.js'
import { allowRule, SETTINGS_FILE, shippedDaemonCommands } from './daemon-commands.js'
import { sha256OfBytes } from './original.js'

export { PROJECT_SETTINGS_FILE, SETTINGS_FILE } from './daemon-commands.js'

type JsonObject = Record<string, unknown>

const GUARD_TIMEOUT_SECONDS = 30

export const GUARD_ENTRY: JsonObject = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/${ATTACH_GUARD.target}`, timeout: GUARD_TIMEOUT_SECONDS }],
}

const WINDOW_HOOK_TIMEOUT_SECONDS = 10

export const WINDOW_EVENTS = ['Stop', 'PreCompact', 'SessionStart', 'PreToolUse', 'PostToolUse'] as const

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
  PostToolUse: { matcher: '*', hooks: [windowHook('heartbeat')] },
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

export const RECORDED_BY_AN_EARLIER_ATTACH = 'node scripts/construct/browser-lab.mjs *'

const PROCESS_TABLE_PROGRAM = 'ps'
const PROCESS_TABLE_ARGUMENTS: readonly string[] = ['-Ao', 'pid=,ppid=,pgid=,lstart=,args=']
export const PROCESS_TABLE_COMMAND = [PROCESS_TABLE_PROGRAM, ...PROCESS_TABLE_ARGUMENTS].join(' ')

export function excludedCommandsWritten(home: string = homedir()): string[] {
  return [...shippedDaemonCommands(home), PROCESS_TABLE_COMMAND]
}

export function browserLabInstalledScript(home: string = homedir()): string {
  return path.join(home, '.construct', 'browser-lab', 'bin', 'browser-lab.mjs')
}

export function browserLabExcludedCommand(home: string = homedir()): string {
  return `node ${browserLabInstalledScript(home)} *`
}

const CONSTRUCT_PROJECT_HOOK = 'scripts/construct/eddies.mjs'
export const HOME_PREFIX = '~/'
export const OWNER_CHANNEL_ENTRY = `${HOME_PREFIX}.construct-owner`
const GIT_DIRECTORY = '.git'
const GIT_DATA_RUNNING_CODE = ['hooks', 'config'] as const
const CARD_TREE_SHARED_GIT_DATA = ['objects', 'refs', 'logs'] as const
const GITHUB_DOMAIN = 'github.com'
export const GITHUB_API_DOMAIN = `api.${GITHUB_DOMAIN}`
export const ROLE_DOMAINS = [GITHUB_DOMAIN, GITHUB_API_DOMAIN, 'registry.npmjs.org'] as const
export const PACKAGE_MANAGER_STORES = ['Library/pnpm/store', '.local/share/pnpm/store', '.npm'] as const

export interface RoleSandbox {
  enabled: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  filesystem: { allowWrite: string[], denyWrite: string[] }
  network: { allowedDomains: string[] }
}

export interface RoleEnvironment {
  allow: string[]
  sandbox: RoleSandbox
}

export function roleEnvironmentAt(factory: string): RoleEnvironment {
  return {
    allow: [`Read(${factory}/**)`],
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [factory, `./${GIT_DIRECTORY}`, ...PACKAGE_MANAGER_STORES.map(store => `${HOME_PREFIX}${store}`)],
        denyWrite: [OWNER_CHANNEL_ENTRY, ...GIT_DATA_RUNNING_CODE.map(entry => `./${GIT_DIRECTORY}/${entry}`)],
      },
      network: { allowedDomains: [...ROLE_DOMAINS] },
    },
  }
}

export function cardTreeGitWrites(gitDir: string, commonDir: string): string[] {
  return [gitDir, ...CARD_TREE_SHARED_GIT_DATA.map(entry => path.join(commonDir, entry))]
}

function objectAt(parent: JsonObject, key: string): JsonObject {
  const value = parent[key]
  return isJsonObject(value) ? value : {}
}

function union(present: unknown, wanted: readonly string[]): unknown[] {
  const held = Array.isArray(present) ? present : []
  return [...held, ...wanted.filter(entry => !held.includes(entry))]
}

function holdsAListAt(parent: JsonObject, key: string): boolean {
  return !(key in parent) || Array.isArray(parent[key])
}

function holdsAnObjectAt(parent: JsonObject, key: string): boolean {
  return !(key in parent) || isJsonObject(parent[key])
}

function carriesTheConstructHook(settings: JsonObject): boolean {
  const entries = objectAt(settings, 'hooks').PreToolUse
  return Array.isArray(entries) && entries.some(entry => names(entry, CONSTRUCT_PROJECT_HOOK))
}

function environmentFits(settings: JsonObject): boolean {
  if (!carriesTheConstructHook(settings) || !holdsAnObjectAt(settings, 'permissions') || !holdsAnObjectAt(settings, 'sandbox'))
    return false
  const sandbox = objectAt(settings, 'sandbox')
  if (!holdsAnObjectAt(sandbox, 'filesystem') || !holdsAnObjectAt(sandbox, 'network') || !holdsAListAt(sandbox, 'excludedCommands'))
    return false
  const filesystem = objectAt(sandbox, 'filesystem')
  return holdsAListAt(objectAt(settings, 'permissions'), 'allow') && holdsAListAt(filesystem, 'allowWrite') && holdsAListAt(filesystem, 'denyWrite') && holdsAListAt(objectAt(sandbox, 'network'), 'allowedDomains')
}

function withoutTheDeadLabEntry(sandbox: JsonObject): JsonObject {
  if (!Array.isArray(sandbox.excludedCommands) || !sandbox.excludedCommands.includes(RECORDED_BY_AN_EARLIER_ATTACH))
    return sandbox
  const { excludedCommands, ...rest } = sandbox
  const remaining = (excludedCommands as unknown[]).filter(command => command !== RECORDED_BY_AN_EARLIER_ATTACH)
  return remaining.length === 0 ? rest : { ...rest, excludedCommands: remaining }
}

export function withRoleEnvironment(settings: JsonObject, environment: RoleEnvironment): JsonObject {
  const permissions = objectAt(settings, 'permissions')
  const sandbox = withoutTheDeadLabEntry(objectAt(settings, 'sandbox'))
  const filesystem = objectAt(sandbox, 'filesystem')
  const network = objectAt(sandbox, 'network')
  const { filesystem: wantedFilesystem, network: wantedNetwork, ...flags } = environment.sandbox
  return {
    ...settings,
    permissions: { ...permissions, allow: union(permissions.allow, environment.allow) },
    sandbox: {
      ...flags,
      ...sandbox,
      filesystem: { ...filesystem, allowWrite: union(filesystem.allowWrite, wantedFilesystem.allowWrite), denyWrite: union(filesystem.denyWrite, wantedFilesystem.denyWrite) },
      network: { ...network, allowedDomains: union(network.allowedDomains, wantedNetwork.allowedDomains) },
    },
  }
}

export function settledSettingsText(text: string, environment: RoleEnvironment): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!isJsonObject(parsed) || !environmentFits(parsed))
    return null
  const settled = withRoleEnvironment(parsed, environment)
  return isDeepStrictEqual(settled, parsed) ? text : `${JSON.stringify(settled, null, 2)}\n`
}

export function daemonAllowRules(home: string = homedir()): string[] {
  return shippedDaemonCommands(home).map(allowRule)
}

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

function excludeCommands(settings: JsonObject, entries: string[]): SandboxExclusion {
  const createdSandbox = !('sandbox' in settings)
  const sandbox: JsonObject = isJsonObject(settings.sandbox) ? settings.sandbox : {}
  const createdExcluded = !('excludedCommands' in sandbox)
  const excluded: unknown[] = Array.isArray(sandbox.excludedCommands) ? sandbox.excludedCommands : []
  const added = entries.filter(entry => !excluded.includes(entry))
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

interface JsonSlot {
  key?: unknown
  start: number
  valueStart: number
  valueEnd: number
}

interface JsonContainer {
  open: number
  close: number
  slots: JsonSlot[]
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r'
}

function skipWhitespace(text: string, from: number): number {
  let at = from
  while (isJsonWhitespace(text[at]))
    at += 1
  return at
}

function endOfString(text: string, open: number): number {
  let at = open + 1
  while (text[at] !== '"')
    at += text[at] === '\\' ? 2 : 1
  return at + 1
}

function endOfLiteral(text: string, start: number): number {
  let at = start
  while (at < text.length && !isJsonWhitespace(text[at]) && !',]}'.includes(text[at]!))
    at += 1
  return at
}

function endOfValue(text: string, start: number): number {
  if (text[start] === '"')
    return endOfString(text, start)
  if (text[start] === '{' || text[start] === '[')
    return readContainer(text, start).close + 1
  return endOfLiteral(text, start)
}

function readContainer(text: string, open: number): JsonContainer {
  const slots: JsonSlot[] = []
  let at = skipWhitespace(text, open + 1)
  while (text[at] !== '}' && text[at] !== ']') {
    const start = at
    let key: unknown
    if (text[open] === '{') {
      const keyEnd = endOfString(text, start)
      key = JSON.parse(text.slice(start, keyEnd))
      at = skipWhitespace(text, skipWhitespace(text, keyEnd) + 1)
    }
    const valueEnd = endOfValue(text, at)
    slots.push({ key, start, valueStart: at, valueEnd })
    at = skipWhitespace(text, valueEnd)
    if (text[at] === ',')
      at = skipWhitespace(text, at + 1)
  }
  return { open, close: at, slots }
}

function renderedAt(value: unknown, indent: string | null): string {
  return indent == null ? JSON.stringify(value) : JSON.stringify(value, null, 2).replaceAll('\n', `\n${indent}`)
}

function indentOfLineAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart, at))?.[0] ?? ''
}

function appendInContainer(text: string, container: JsonContainer, render: (indent: string | null) => string): string {
  const last = container.slots.at(-1)
  if (last == null) {
    const outer = indentOfLineAt(text, container.open)
    const indent = `${outer}  `
    return `${text.slice(0, container.open + 1)}\n${indent}${render(indent)}\n${outer}${text.slice(container.close)}`
  }
  let leadStart = last.start
  while (isJsonWhitespace(text[leadStart - 1]))
    leadStart -= 1
  const lead = text.slice(leadStart, last.start)
  const indent = lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n') + 1) : null
  return `${text.slice(0, last.valueEnd)},${lead}${render(indent)}${text.slice(last.valueEnd)}`
}

function slotNamed(container: JsonContainer, key: string): JsonSlot | undefined {
  return container.slots.filter(slot => slot.key === key).at(-1)
}

function withArrayEntry(text: string, outer: string, inner: string, entry: string): string {
  const root = readContainer(text, skipWhitespace(text, 0))
  const outerSlot = slotNamed(root, outer)
  if (outerSlot == null)
    return appendInContainer(text, root, indent => `${JSON.stringify(outer)}: ${renderedAt({ [inner]: [entry] }, indent)}`)
  const container = readContainer(text, outerSlot.valueStart)
  const innerSlot = slotNamed(container, inner)
  if (innerSlot == null)
    return appendInContainer(text, container, indent => `${JSON.stringify(inner)}: ${renderedAt([entry], indent)}`)
  return appendInContainer(text, readContainer(text, innerSlot.valueStart), () => JSON.stringify(entry))
}

function excludedListIn(text: string): JsonContainer | null {
  const root = readContainer(text, skipWhitespace(text, 0))
  const sandboxSlot = slotNamed(root, 'sandbox')
  if (sandboxSlot == null || text[sandboxSlot.valueStart] !== '{')
    return null
  const excludedSlot = slotNamed(readContainer(text, sandboxSlot.valueStart), 'excludedCommands')
  return excludedSlot == null || text[excludedSlot.valueStart] !== '[' ? null : readContainer(text, excludedSlot.valueStart)
}

function withoutExcludedCommand(text: string, entry: string): string {
  const list = excludedListIn(text)
  const at = list == null ? -1 : list.slots.findIndex(slot => text.slice(slot.valueStart, slot.valueEnd) === JSON.stringify(entry))
  if (list == null || at === -1)
    return text
  const slot = list.slots[at]!
  if (list.slots.length === 1)
    return `${text.slice(0, list.open + 1)}${text.slice(list.close)}`
  if (at === 0)
    return `${text.slice(0, slot.start)}${text.slice(list.slots[1]!.start)}`
  return `${text.slice(0, list.slots[at - 1]!.valueEnd)}${text.slice(slot.valueEnd)}`
}

export interface LocalExclusion extends SandboxExclusion {
  allow: EngramPermissions
  createdFile: boolean
  beforeSha256: string | null
  afterSha256: string | null
}

export function wroteLocally(exclusion: LocalExclusion): boolean {
  return exclusion.afterSha256 !== exclusion.beforeSha256
}

export function excludeBrowserLabInLocalSettings(root: string, home: string = homedir(), dropTheDeadEntry: boolean = false): LocalExclusion | null {
  const reading = readSettings(root)
  if (reading.kind === 'unreadable')
    return null
  const commands = shippedDaemonCommands(home)
  const settings = reading.kind === 'read' ? structuredClone(reading.settings) : {}
  const allow = allowEngram(settings, commands.map(allowRule))
  const exclusion = excludeCommands(settings, excludedCommandsWritten(home))
  const beforeSha256 = reading.kind === 'read' ? sha256OfBytes(reading.bytes) : null
  const createdFile = reading.kind === 'absent'
  const initial = reading.kind === 'read' ? reading.bytes.toString('utf8') : '{}\n'
  const excluded = exclusion.added.reduce((text, command) => withArrayEntry(text, 'sandbox', 'excludedCommands', command), initial)
  const allowed = allow.added.reduce((written, rule) => withArrayEntry(written, 'permissions', 'allow', rule), excluded)
  const text = dropTheDeadEntry ? withoutExcludedCommand(allowed, RECORDED_BY_AN_EARLIER_ATTACH) : allowed
  if (text === initial)
    return { ...exclusion, allow, createdFile, beforeSha256, afterSha256: beforeSha256 }
  const bytes = Buffer.from(text)
  writeSettingsBytes(root, bytes)
  return { ...exclusion, allow, createdFile, beforeSha256, afterSha256: sha256OfBytes(bytes) }
}

function isLinkedWorktree(root: string): boolean {
  return existsSync(path.join(root, '.git')) && !lstatSync(path.join(root, '.git')).isDirectory()
}

export function excludedBrowserLabLocally(root: string, home: string = homedir(), constructOwnsProjectSettings: boolean = false): LocalExclusion | null {
  try {
    if (isLinkedWorktree(root))
      return null
    const index = readTrackedPaths(root)
    if (!('tracked' in index) || index.tracked.has(SETTINGS_FILE))
      return null
    return excludeBrowserLabInLocalSettings(root, home, constructOwnsProjectSettings)
  }
  catch {
    return null
  }
}

export function withExclusionRecorded(hook: SettingsHook, exclusion: LocalExclusion): SettingsHook {
  const held = hook.sandbox
  const sandbox: SandboxExclusion = {
    added: [...new Set([...(held?.added ?? []), ...exclusion.added])],
    createdSandbox: held?.createdSandbox === true || exclusion.createdSandbox,
    createdExcluded: held?.createdExcluded === true || exclusion.createdExcluded,
  }
  const engram: EngramPermissions = {
    added: [...new Set([...(hook.engram?.added ?? []), ...exclusion.allow.added])],
    createdPermissions: hook.engram?.createdPermissions === true || exclusion.allow.createdPermissions,
    createdAllow: hook.engram?.createdAllow === true || exclusion.allow.createdAllow,
  }
  const original = hook.original
  const untouchedSinceAttach = original != null && original.afterSha256 === exclusion.beforeSha256 && exclusion.afterSha256 != null
  return {
    ...hook,
    created: { ...hook.created, file: hook.created.file || (exclusion.createdFile && original == null) },
    sandbox,
    ...(hook.engram == null && exclusion.allow.added.length === 0 ? {} : { engram }),
    ...(untouchedSinceAttach ? { original: { ...original, afterSha256: exclusion.afterSha256! } } : {}),
  }
}

function isSandboxRecord(value: unknown): boolean {
  return value === undefined || (isJsonObject(value) && Array.isArray(value.added) && value.added.every(command => command === RECORDED_BY_AN_EARLIER_ATTACH || command === browserLabExcludedCommand() || excludedCommandsWritten().includes(command as string)) && typeof value.createdSandbox === 'boolean' && typeof value.createdExcluded === 'boolean')
}

function isEngramRecord(value: unknown): boolean {
  return value === undefined || (isJsonObject(value) && Array.isArray(value.added) && value.added.every(rule => typeof rule === 'string') && typeof value.createdPermissions === 'boolean' && typeof value.createdAllow === 'boolean')
}

export type SettingsInstall
  = | { kind: 'installed', hook: SettingsHook, afterSha256: string }
    | { kind: 'unreadable' }
    | { kind: 'guarded' }

export function installHookEntries(root: string, reading: SettingsReading, home: string = homedir()): SettingsInstall {
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
  const engram = allowEngram(settings, [...engramRules(root, home), ...daemonAllowRules(home)])
  const sandbox = excludeCommands(settings, excludedCommandsWritten(home))
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

function holdsRecordedExclusion(settings: JsonObject, hook: SettingsHook): boolean {
  const excluded = isJsonObject(settings.sandbox) ? settings.sandbox.excludedCommands : undefined
  return Array.isArray(excluded) && (hook.sandbox?.added ?? []).some(command => excluded.includes(command))
}

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
    return holdsRecordedExclusion(settings, hook) ? 'remove' : 'absent'
  return named.every(({ recorded, found }) => found.every(element => isDeepStrictEqual(element, recorded.entry))) ? 'remove' : 'changed'
}

export function removeHookEntries(root: string, hook: SettingsHook): { fileDeleted: boolean } {
  const reading = readSettings(root)
  if (reading.kind !== 'read')
    throw new Error(`${SETTINGS_FILE} changed while detach ran`)
  const settings = reading.settings
  const hooks: JsonObject = isJsonObject(settings.hooks) ? settings.hooks : {}
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
