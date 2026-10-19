import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unresolvedCommandWord } from '../../src/commands/intake/command-word.js'

export const NO_ISOLATION = 'no_isolation'

export type SettingsLayer = Record<string, unknown> | null

export interface IsolationFacts {
  managed: SettingsLayer
  local: SettingsLayer
  project: SettingsLayer
  user: SettingsLayer
  platform: string
  sandboxExec: boolean
  bwrap: boolean
  socat: boolean
  command: string[]
}

export type Isolation
  = | { level: 'full' | 'partial', mechanism: 'claude-code-sandbox', gaps: string[] }
    | { level: 'none', why: string }

export type IsolationReader = () => Isolation

type Fields = Record<string, unknown>

const MANAGED_SETTINGS: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
}
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const OVERRIDE_WORDS = ['--settings', '--setting-sources', 'dangerously-skip-permissions', 'bypassPermissions']
const ENABLE_IT = 'enable sandbox.enabled in the user or managed settings'
const TSX_PIPE_PATH = /^\/\S*\/tsx-\d+(?:\/\d+\.pipe)?$/

function fieldsOf(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : null
}

function sandboxLayers(facts: IsolationFacts): Fields[] {
  return [facts.managed, facts.local, facts.project, facts.user].map(layer => fieldsOf(fieldsOf(layer)?.sandbox) ?? {})
}

function networkLayers(sandboxes: Fields[]): Fields[] {
  return sandboxes.map(sandbox => fieldsOf(sandbox.network) ?? {})
}

function scalar(layers: Fields[], key: string): unknown {
  return layers.find(layer => layer[key] !== undefined)?.[key]
}

function union(layers: Fields[], key: string): unknown[] {
  return layers.flatMap(layer => Array.isArray(layer[key]) ? layer[key] as unknown[] : [])
}

function setBeyondFalse(value: unknown): boolean {
  return value !== undefined && value !== false
}

function causesOf(facts: IsolationFacts, enabled: unknown): string[] {
  const causes: string[] = []
  if (enabled !== true)
    causes.push(`sandbox.enabled is not true in the merged managed, local, project and user settings; ${ENABLE_IT}`)
  if (facts.platform === 'darwin' && !facts.sandboxExec)
    causes.push(`${SANDBOX_EXEC} is missing; the macOS sandbox cannot start without it`)
  else if (facts.platform === 'linux' && (!facts.bwrap || !facts.socat))
    causes.push(`${[facts.bwrap ? null : 'bwrap', facts.socat ? null : 'socat'].filter(word => word !== null).join(' and ')} not found on PATH; the Linux sandbox needs bwrap and socat`)
  else if (facts.platform !== 'darwin' && facts.platform !== 'linux')
    causes.push(`the Claude Code sandbox has no backend on ${facts.platform}`)
  const overriding = facts.command.filter(word => OVERRIDE_WORDS.some(override => word.includes(override)))
  if (overriding.length > 0)
    causes.push(`the session command ${facts.command.join(' ')} carries ${overriding.join(' ')}, which can lift the sandbox settings; remove it from the session command`)
  return causes
}

function gapsOf(sandboxes: Fields[]): string[] {
  const network = networkLayers(sandboxes)
  const gaps: string[] = []
  if (scalar(sandboxes, 'allowUnsandboxedCommands') !== false)
    gaps.push('sandbox.allowUnsandboxedCommands is not false; a command may be retried outside the sandbox')
  const excluded = union(sandboxes, 'excludedCommands')
  if (excluded.length > 0)
    gaps.push(`sandbox.excludedCommands names ${excluded.map(String).join(', ')}; they run outside the sandbox`)
  if (setBeyondFalse(scalar(network, 'allowAllUnixSockets')))
    gaps.push('sandbox.network.allowAllUnixSockets is set; every unix socket is reachable')
  const sockets = union(network, 'allowUnixSockets').filter(socket => typeof socket !== 'string' || !TSX_PIPE_PATH.test(socket))
  if (sockets.length > 0)
    gaps.push(`sandbox.network.allowUnixSockets names ${sockets.map(String).join(', ')}`)
  if (setBeyondFalse(scalar(network, 'allowLocalBinding')))
    gaps.push('sandbox.network.allowLocalBinding is set; the session may bind local ports')
  if (setBeyondFalse(scalar(sandboxes, 'enableWeakerNestedSandbox')))
    gaps.push('sandbox.enableWeakerNestedSandbox is set; the nested sandbox is weaker')
  return gaps
}

export function runtimeIsolation(facts: IsolationFacts): Isolation {
  const sandboxes = sandboxLayers(facts)
  const causes = causesOf(facts, scalar(sandboxes, 'enabled'))
  if (causes.length > 0)
    return { level: 'none', why: causes.join('; ') }
  const gaps = gapsOf(sandboxes)
  return { level: gaps.length === 0 ? 'full' : 'partial', mechanism: 'claude-code-sandbox', gaps }
}

function readLayer(file: string): SettingsLayer {
  try {
    return fieldsOf(JSON.parse(readFileSync(file, 'utf8')))
  }
  catch {
    return null
  }
}

function onPath(word: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return unresolvedCommandWord(word, env.PATH ?? '') === null
  }
  catch {
    return false
  }
}

function sandboxExecPresent(): boolean {
  try {
    return existsSync(SANDBOX_EXEC)
  }
  catch {
    return false
  }
}

export function commandWords(command: string): string[] {
  return command.split(/\s+/).filter(word => word !== '')
}

export interface SettingsPaths {
  managed: string | null
  local: string
  project: string
  user: string
}

export function settingsPaths(env: NodeJS.ProcessEnv, cwd: string, platform: string, home: string): SettingsPaths {
  const configDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude')
  return {
    managed: MANAGED_SETTINGS[platform] ?? null,
    local: path.join(cwd, '.claude', 'settings.local.json'),
    project: path.join(cwd, '.claude', 'settings.json'),
    user: path.join(configDir, 'settings.json'),
  }
}

export function readIsolationFacts(env: NodeJS.ProcessEnv, cwd: string, command: string[]): IsolationFacts {
  const platform = os.platform()
  const paths = settingsPaths(env, cwd, platform, os.homedir())
  return {
    managed: paths.managed === null ? null : readLayer(paths.managed),
    local: readLayer(paths.local),
    project: readLayer(paths.project),
    user: readLayer(paths.user),
    platform,
    sandboxExec: sandboxExecPresent(),
    bwrap: onPath('bwrap', env),
    socat: onPath('socat', env),
    command,
  }
}

export function realIsolationReader(env: NodeJS.ProcessEnv, cwd: string, command: string[]): IsolationReader {
  return () => runtimeIsolation(readIsolationFacts(env, cwd, command))
}
