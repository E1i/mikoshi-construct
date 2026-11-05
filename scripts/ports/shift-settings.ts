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

export function shiftSettings(tree: string, gate: ShiftGate, writable: string[] = [], home: string = os.homedir()): ShiftSettings {
  const allow = [
    ...gate.prepush.map(command => `Bash(${command})`),
    `Edit(/${tree}/**)`,
    ...writable.map(file => `Edit(/${file})`),
  ]
  const entry = browserLabExcludedCommand(home)
  const excluded = existsSync(browserLabInstalledScript(home)) && REPOSITORY_SETTINGS_FILES.some(file => excludes(path.join(tree, file), entry))
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
