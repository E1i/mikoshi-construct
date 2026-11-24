import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { agentLabel, BUS_DIR, BUS_FILE, busPathOf, GH_ACCOUNT_VARIABLE, isOwnerCheckout, LAUNCH_AGENTS, repoHome, repoIdOf } from '../../../scripts/core/bus-path.js'
import { handoffDirOf } from '../../../scripts/core/handoff-dir.js'
import { constructCommand, pnpmCommand } from '../../../scripts/core/owner-commands.js'
import { inForceInProjection } from '../../../scripts/policy/decisions/decisions.js'
import { namesQueueLive } from '../../../scripts/policy/live-decision.js'
import { FACTORY_MANIFEST } from '../../../scripts/policy/touch-scope.js'
import { readManifest, recordedShas } from '../../manifest.js'
import { MIKOSHI_PNPM, pinnedPnpm } from '../../presets/index.js'
import { allowRule, cardTreeGitWrites, daemonProgram, shippedDaemonCommands } from '../attach/daemon-commands.js'
import { browserLabInstalledScript, excludedCommandsWritten, GITHUB_API_DOMAIN, HOME_PREFIX, PROCESS_TABLE_COMMAND } from '../attach/settings.js'
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
  'role-environment': 'PARITY',
  'browser-lab-roles': 'PARITY',
  'gh-account': 'PARITY',
  'window-live': 'PARITY',
  'window-continue': 'ONEWORD',
  'live-merge': 'ONEWORD',
  'live-update': 'ONEWORD',
} as const satisfies Record<string, FactorySlice>
export type FactoryItemName = keyof typeof FACTORY_ITEMS

export const SYNC_APPLY = constructCommand('sync', '--apply')
export const RESTORE_FROM_GIT = 'git restore --'
export const PIN_PNPM_FLOOR = `corepack use pnpm@${MIKOSHI_PNPM}`
export const IGNORE_PNPM_STORE = `printf '.pnpm-store/\\n' >> .gitignore`
export const OPEN_A_WINDOW = 'claude'
export const SWITCH_GH_ACCOUNT = 'gh auth switch --user'
export const EDIT_LOCAL_SETTINGS = '$EDITOR .claude/settings.local.json'
export const GHOST_PROTOCOL_HOURS = 6
export const OWNER_WORD = `ghost-protocol ${GHOST_PROTOCOL_HOURS}h`
export const SWITCH_TO_GHOST_PROTOCOL = `${constructCommand('say', `"${OWNER_WORD}"`)} && construct-factory --mode ghost-protocol`

const SETTINGS = '.claude/settings.json'
const LOCAL_SETTINGS = '.claude/settings.local.json'
const WIDENING_PERMISSIONS = ['allow', 'additionalDirectories', 'defaultMode'] as const
const WINDOW_HANDOFF = 'miko.md'
const HANDOFF_VARIABLE = 'CONSTRUCT_HANDOFF'
const STATUS_LINE = /^STATUS:\s*(CONTINUE|OWNER|DONE|STOP)\b/
const CONTINUE = 'CONTINUE'
const PNPM_STORE_LINE = '.pnpm-store/'
const PNPM_PIN = /^pnpm@(\d+\.\d+\.\d+)/
const GH_HOSTS = 'hosts.yml'
const GH_HOST_LINE = 'github.com:'
const GH_ACTIVE_USER = /^(\s+)user:\s*(\S+)\s*$/
const INDENTED = /^(\s+)\S/

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
  refused?: string[]
}

export const ROLES = ['window', 'launch', 'answer', 'review'] as const
export type RoleName = typeof ROLES[number]
export const LAB_ROLES: readonly RoleName[] = ['window', 'launch', 'answer']

export interface FirstStep {
  role: RoleName
  step: string
  command: string
  writes: string[]
  domains: string[]
}

export interface SettingsLayer {
  settings: Record<string, unknown> | null
  base: string
}

export interface RoleSituation {
  cwd: string
  home: string
  layers: SettingsLayer[]
}

export interface StepReading {
  refused: string | null
  outsideTheSandbox: boolean
}

interface MergedEnvironment {
  enabled: boolean
  autoAllow: boolean
  allow: string[]
  deny: string[]
  allowWrite: string[]
  denyWrite: string[]
  domains: string[]
  excluded: string[]
}

const CARD_TREE_NAME = 'card'
const LAB_STEP = 'page http://localhost --shot shot.png'

function at(value: unknown, key: string): unknown {
  return plainObject(value) ? value[key] : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : []
}

function lastSet(layers: SettingsLayer[], read: (settings: unknown) => unknown, fallback: boolean): boolean {
  const set = layers.map(layer => read(layer.settings)).filter(value => typeof value === 'boolean')
  return set.at(-1) ?? fallback
}

function resolvedEntry(entry: string, base: string, home: string): string {
  if (entry.startsWith(HOME_PREFIX))
    return path.join(home, entry.slice(HOME_PREFIX.length))
  return path.resolve(base, entry.startsWith('//') ? entry.slice(1) : entry)
}

function resolvedAll(layers: SettingsLayer[], home: string, read: (sandbox: unknown) => unknown): string[] {
  return layers.flatMap(layer => strings(read(at(layer.settings, 'sandbox'))).map(entry => resolvedEntry(entry, layer.base, home)))
}

export function mergedEnvironment(situation: RoleSituation): MergedEnvironment {
  const { layers, home } = situation
  const all = (read: (settings: unknown) => unknown): string[] => layers.flatMap(layer => strings(read(layer.settings)))
  return {
    enabled: lastSet(layers, settings => at(at(settings, 'sandbox'), 'enabled'), false),
    autoAllow: lastSet(layers, settings => at(at(settings, 'sandbox'), 'autoAllowBashIfSandboxed'), true),
    allow: all(settings => at(at(settings, 'permissions'), 'allow')),
    deny: all(settings => at(at(settings, 'permissions'), 'deny')),
    allowWrite: resolvedAll(layers, home, sandbox => at(at(sandbox, 'filesystem'), 'allowWrite')),
    denyWrite: resolvedAll(layers, home, sandbox => at(at(sandbox, 'filesystem'), 'denyWrite')),
    domains: all(settings => at(at(at(settings, 'sandbox'), 'network'), 'allowedDomains')),
    excluded: all(settings => at(at(settings, 'sandbox'), 'excludedCommands')),
  }
}

function matchesPattern(command: string, pattern: string): boolean {
  const prefix = /^(.*?)(?::\*| \*|\*)$/.exec(pattern)?.[1]
  return prefix === undefined ? command === pattern : command === prefix || command.startsWith(prefix.endsWith(' ') ? prefix : `${prefix} `)
}

function bashRuleMatches(rules: string[], command: string): boolean {
  return rules.some(rule => rule === 'Bash' || matchesPattern(command, /^Bash\((.*)\)$/.exec(rule)?.[1] ?? '\0'))
}

function inside(target: string, directory: string): boolean {
  return target === directory || target.startsWith(`${directory}${path.sep}`)
}

function domainAllowed(domains: string[], domain: string): boolean {
  return domains.some(allowed => allowed === domain || (allowed.startsWith('*.') && domain.endsWith(allowed.slice(1))))
}

export function readStep(situation: RoleSituation, step: FirstStep): StepReading {
  const environment = mergedEnvironment(situation)
  if (bashRuleMatches(environment.deny, step.command))
    return { refused: 'a deny rule names the command', outsideTheSandbox: false }
  if (!bashRuleMatches(environment.allow, step.command) && !(environment.enabled && environment.autoAllow))
    return { refused: 'no allow rule and no sandbox lets the command run', outsideTheSandbox: false }
  const outsideTheSandbox = !environment.enabled || environment.excluded.some(pattern => matchesPattern(step.command, pattern))
  if (outsideTheSandbox)
    return { refused: null, outsideTheSandbox }
  const blocked = step.writes.find(target => environment.denyWrite.some(entry => inside(target, entry)) || !(inside(target, situation.cwd) || environment.allowWrite.some(entry => inside(target, entry))))
  if (blocked !== undefined)
    return { refused: `the sandbox refuses the write to ${blocked}`, outsideTheSandbox }
  const unreached = step.domains.find(domain => !domainAllowed(environment.domains, domain))
  return { refused: unreached === undefined ? null : `the sandbox network does not reach ${unreached}`, outsideTheSandbox }
}

function gitCommitWrites(gitDir: string, commonDir: string): string[] {
  return [path.join(gitDir, 'index'), path.join(commonDir, 'objects'), path.join(commonDir, 'refs', 'heads')]
}

export function windowFirstSteps(root: string, home: string, handoff: string): FirstStep[] {
  const git = path.join(root, '.git')
  return [
    { role: 'window', step: 'read the handoff', command: `cat ${handoff}`, writes: [], domains: [] },
    { role: 'window', step: 'miko watch --once', command: 'miko watch --once', writes: [path.join(repoHome(home, repoIdOf(root)), BUS_FILE)], domains: [GITHUB_API_DOMAIN] },
    { role: 'window', step: 'git commit in a branch', command: 'git commit -m step', writes: gitCommitWrites(git, git), domains: [] },
  ]
}

export function cardFirstSteps(gitDir: string, commonDir: string): FirstStep[] {
  return [
    { role: 'launch', step: 'git commit in the card tree', command: 'git commit -m step', writes: gitCommitWrites(gitDir, commonDir), domains: [] },
    { role: 'answer', step: 'git commit in the card tree', command: 'git commit -m step', writes: gitCommitWrites(gitDir, commonDir), domains: [] },
    { role: 'review', step: 'git diff in the card tree', command: 'git diff', writes: [], domains: [] },
  ]
}

export function browserLabStep(role: RoleName, home: string): FirstStep {
  return { role, step: 'browser-lab', command: `node ${browserLabInstalledScript(home)} ${LAB_STEP}`, writes: [], domains: [] }
}

export interface RoleSituations {
  window: RoleSituation
  card: RoleSituation
  cardTree: { gitDir: string, commonDir: string }
  labInstalled: boolean
}

function excludes(settings: Record<string, unknown> | null, entry: string): boolean {
  return strings(at(at(settings, 'sandbox'), 'excludedCommands')).includes(entry)
}

function installed(program: string): boolean {
  return new FileReadings(path.dirname(program)).entries('.')?.includes(path.basename(program)) === true
}

function installedDaemonProgram(command: string): boolean {
  const program = daemonProgram(command)
  return program !== null && installed(program)
}

export function roleSituations(readings: FileReadings, root: string, home: string, daemonCommands: readonly string[] = shippedDaemonCommands(home)): RoleSituations {
  const project = readings.readJson(SETTINGS)
  const local = readings.readJson(LOCAL_SETTINGS)
  const tree = path.join(repoHome(home, repoIdOf(root)), BUS_DIR, 'worktrees', CARD_TREE_NAME)
  const commonDir = path.join(root, '.git')
  const gitDir = path.join(commonDir, 'worktrees', CARD_TREE_NAME)
  const labInstalled = installed(browserLabInstalledScript(home))
  const leftOut = daemonCommands.filter(command => installedDaemonProgram(command) && (excludes(project, command) || excludes(local, command)))
  const flag = { sandbox: { enabled: true, filesystem: { allowWrite: cardTreeGitWrites(gitDir, commonDir) }, excludedCommands: [...leftOut, PROCESS_TABLE_COMMAND] } }
  return {
    window: { cwd: root, home, layers: [{ settings: project, base: root }, { settings: local, base: root }] },
    card: { cwd: tree, home, layers: [{ settings: project, base: tree }, { settings: flag, base: tree }] },
    cardTree: { gitDir, commonDir },
    labInstalled,
  }
}

function situationOf(situations: RoleSituations, role: RoleName): RoleSituation {
  return role === 'window' ? situations.window : situations.card
}

export function refusedFirstSteps(situations: RoleSituations, handoff: string, root: string): string[] {
  const steps = [...windowFirstSteps(root, situations.window.home, handoff), ...cardFirstSteps(situations.cardTree.gitDir, situations.cardTree.commonDir)]
  return steps.filter(step => readStep(situationOf(situations, step.role), step).refused !== null).map(step => `${step.role}: ${step.step}`)
}

export function rolesWithoutTheLab(situations: RoleSituations): RoleName[] {
  if (!situations.labInstalled)
    return []
  return LAB_ROLES.filter((role) => {
    const reading = readStep(situationOf(situations, role), browserLabStep(role, situations.window.home))
    return reading.refused !== null || !reading.outsideTheSandbox
  })
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

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function holdsOnly(list: unknown, granted: readonly string[]): boolean {
  return Array.isArray(list) && list.length > 0 && list.every(entry => typeof entry === 'string' && granted.includes(entry))
}

function sandboxOnlyExcludesDaemons(sandbox: unknown, commands: readonly string[]): boolean {
  return plainObject(sandbox) && Object.keys(sandbox).length === 1 && holdsOnly(sandbox.excludedCommands, commands)
}

function widensPermissions(permissions: Record<string, unknown>, commands: readonly string[]): boolean {
  if (present(permissions.allow) && !holdsOnly(permissions.allow, commands.map(allowRule)))
    return true
  return WIDENING_PERMISSIONS.some(key => key !== 'allow' && present(permissions[key]))
}

function widensCardSessions(readings: FileReadings, home: string): boolean {
  if (readings.read(LOCAL_SETTINGS) === null)
    return readings.unreadable(LOCAL_SETTINGS)
  const local: unknown = readings.readJson(LOCAL_SETTINGS)
  if (!plainObject(local))
    return true
  const permissions = local.permissions ?? {}
  if (!plainObject(permissions))
    return true
  const commands = shippedDaemonCommands(home)
  const widensSandbox = local.sandbox !== undefined && !sandboxOnlyExcludesDaemons(local.sandbox, excludedCommandsWritten(home))
  return widensSandbox || widensPermissions(permissions, commands)
}

function named(env: NodeJS.ProcessEnv, variable: string): string | null {
  const value = env[variable]
  return value === undefined || value === '' ? null : value
}

function windowHandoffOf(situation: FactorySituation, root: string): string {
  return named(situation.env, HANDOFF_VARIABLE) ?? path.join(handoffDirOf(situation.env, situation.home, root), WINDOW_HANDOFF)
}

function lastStatus(handoff: string): string | null {
  const text = new FileReadings(path.dirname(handoff)).read(path.basename(handoff)) ?? ''
  return text.split(/\r?\n/).flatMap(line => STATUS_LINE.exec(line)?.[1] ?? []).at(-1) ?? null
}

function writeContinueCommand(root: string, handoff: string): string {
  return `${isOwnerCheckout(root) ? pnpmCommand('handoff:write') : 'miko handoff write'} ${handoff} <draft ending STATUS: ${CONTINUE}>`
}

function liveQueues(bus: string, now: Date): (queue: string) => boolean {
  const decisions = inForceInProjection(bus, file => new FileReadings(path.dirname(file)).read(path.basename(file)), now)
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

function recordedGhAccount(situation: FactorySituation, root: string): string | null {
  const plist = new FileReadings(path.join(situation.home, LAUNCH_AGENTS)).read(`${agentLabel(root)}.plist`) ?? ''
  return new RegExp(`<key>${GH_ACCOUNT_VARIABLE}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1] ?? null
}

function ghConfigDir(situation: FactorySituation): string {
  const xdg = named(situation.env, 'XDG_CONFIG_HOME')
  return named(situation.env, 'GH_CONFIG_DIR') ?? path.join(xdg ?? path.join(situation.home, '.config'), 'gh')
}

function activeGhAccount(situation: FactorySituation): string | null {
  const lines = (new FileReadings(ghConfigDir(situation)).read(GH_HOSTS) ?? '').split(/\r?\n/)
  const host = lines.indexOf(GH_HOST_LINE)
  if (host === -1)
    return null
  const end = lines.findIndex((line, at) => at > host && !INDENTED.test(line))
  const body = lines.slice(host + 1, end === -1 ? lines.length : end)
  const indent = INDENTED.exec(body[0] ?? '')?.[1]
  const active = body.map(line => GH_ACTIVE_USER.exec(line)).find(match => match !== null && match[1] === indent)
  return active?.[2] ?? null
}

function ghAccountItem(situation: FactorySituation, root: string): FactoryItem {
  const recorded = recordedGhAccount(situation, root)
  const active = activeGhAccount(situation)
  const differs = recorded !== null && active !== null && recorded.toLowerCase() !== active.toLowerCase()
  return { item: 'gh-account', slice: FACTORY_ITEMS['gh-account'], goes: true, command: differs ? `${SWITCH_GH_ACCOUNT} ${recorded}` : null }
}

function item(name: FactoryItemName, goes: boolean, command: string): FactoryItem {
  return { item: name, slice: FACTORY_ITEMS[name], goes, command: goes ? null : command }
}

function namingItem(name: FactoryItemName, refused: string[], command: string): FactoryItem {
  return refused.length === 0 ? item(name, true, command) : { ...item(name, false, command), refused }
}

export function factoryChecklist(root: string, situation: FactorySituation = { env: process.env, home: homedir(), now: new Date() }): FactoryChecklist {
  const readings = new FileReadings(root)
  const bus = busPathOf(situation.env, situation.home, root, isOwnerCheckout(root))
  const live = liveQueues(bus, situation.now)
  const handoff = windowHandoffOf(situation, root)
  const missing = FACTORY_MANIFEST.filter(file => readings.read(file) === null)
  const roles = roleSituations(readings, root, situation.home)
  const items = [
    item('factory-files', missing.length === 0, factoryFilesCommand(root, missing)),
    item('factory-hooks', carriesFactoryHooks(readings), SYNC_APPLY),
    item('pnpm-floor', pnpmAtTheFloor(readings), PIN_PNPM_FLOOR),
    item('pnpm-store-ignored', ignoresPnpmStore(readings), IGNORE_PNPM_STORE),
    item('card-permissions', !widensCardSessions(readings, situation.home), EDIT_LOCAL_SETTINGS),
    namingItem('role-environment', refusedFirstSteps(roles, handoff, root), SYNC_APPLY),
    namingItem('browser-lab-roles', rolesWithoutTheLab(roles), SYNC_APPLY),
    ghAccountItem(situation, root),
    item('window-live', factoryLiveness(bus, situation.now.getTime()).state === 'live', OPEN_A_WINDOW),
    item('window-continue', lastStatus(handoff) === CONTINUE, writeContinueCommand(root, handoff)),
    item('live-merge', live('merge'), SWITCH_TO_GHOST_PROTOCOL),
    item('live-update', live('update'), SWITCH_TO_GHOST_PROTOCOL),
  ]
  return { goes: items.every(entry => entry.goes), bus, items }
}
