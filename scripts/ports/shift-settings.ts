import type { ShiftGate } from '../../src/manifest.js'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { browserLabExcludedCommand, browserLabInstalledScript, SETTINGS_FILE } from '../../src/commands/attach/settings.js'
import { isJsonObject } from '../../src/materialize/strategies.js'

const SANDBOX_UID = os.userInfo().uid

export const TSX_PIPE_DIRECTORY = `/tmp/claude-${SANDBOX_UID}/tsx-${SANDBOX_UID}`

export const CARD_SESSION_SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true, allowUnixSockets: [TSX_PIPE_DIRECTORY] } } as const

const BROWSER_LAB_SCRIPT = 'scripts/construct/browser-lab.mjs'

const REPOSITORY_SETTINGS_FILES = ['.claude/settings.json', SETTINGS_FILE]

const GITDIR_POINTER = /^gitdir:[ \t]*(\S.*)$/m

export interface ShiftSettings {
  sandbox: typeof CARD_SESSION_SANDBOX & { excludedCommands?: string[], filesystem?: { denyWrite: string[] } }
  permissions: { allow: string[], deny?: string[] }
}

function excludes(file: string, entry: string): boolean {
  try {
    const settings: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isJsonObject(settings) && isJsonObject(settings.sandbox) && Array.isArray(settings.sandbox.excludedCommands) && settings.sandbox.excludedCommands.includes(entry)
  }
  catch {
    return false
  }
}

function gitDirOfLinkedTree(tree: string): string | null {
  try {
    const pointer = GITDIR_POINTER.exec(readFileSync(path.join(tree, '.git'), 'utf8'))?.[1]
    return pointer === undefined ? null : path.resolve(tree, pointer.trim())
  }
  catch {
    return null
  }
}

function mainCheckoutOf(tree: string): string | null {
  const gitDir = gitDirOfLinkedTree(tree)
  if (gitDir === null)
    return null
  try {
    const common = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
    return path.basename(common) === '.git' ? path.dirname(common) : null
  }
  catch {
    return null
  }
}

function mainCheckoutExcludes(tree: string, entry: string): boolean {
  const main = mainCheckoutOf(tree)
  return main !== null && excludes(path.join(main, SETTINGS_FILE), entry)
}

export function shiftSettings(tree: string, gate: ShiftGate, writable: string[] = [], home: string = os.homedir()): ShiftSettings {
  const allow = [
    ...gate.prepush.map(command => `Bash(${command})`),
    `Edit(/${tree}/**)`,
    ...writable.map(file => `Edit(/${file})`),
  ]
  const entry = browserLabExcludedCommand(home)
  const excluded = existsSync(browserLabInstalledScript(home)) && (REPOSITORY_SETTINGS_FILES.some(file => excludes(path.join(tree, file), entry)) || mainCheckoutExcludes(tree, entry))
  if (!excluded)
    return { sandbox: CARD_SESSION_SANDBOX, permissions: { allow } }
  const lab = path.join(tree, BROWSER_LAB_SCRIPT)
  const labHome = path.join(home, '.construct', 'browser-lab')
  return {
    sandbox: { ...CARD_SESSION_SANDBOX, excludedCommands: [entry], filesystem: { denyWrite: [lab, labHome] } },
    permissions: { allow, deny: [`Edit(/${lab})`, `Edit(/${labHome}/**)`] },
  }
}

export function settingsFlag(settings: ShiftSettings): string[] {
  return ['--setting-sources', 'project,local', '--settings', JSON.stringify(settings)]
}
