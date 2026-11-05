import type { ShiftGate } from '../../src/manifest.js'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BROWSER_LAB_EXCLUDED_COMMAND, SETTINGS_FILE } from '../../src/commands/attach/settings.js'
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

function excludesBrowserLab(file: string): boolean {
  try {
    const settings: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isJsonObject(settings) && isJsonObject(settings.sandbox) && Array.isArray(settings.sandbox.excludedCommands) && settings.sandbox.excludedCommands.includes(BROWSER_LAB_EXCLUDED_COMMAND)
  }
  catch {
    return false
  }
}

export function shiftSettings(tree: string, gate: ShiftGate, writable: string[] = []): ShiftSettings {
  const allow = [
    ...gate.prepush.map(command => `Bash(${command})`),
    `Edit(/${tree}/**)`,
    ...writable.map(file => `Edit(/${file})`),
  ]
  if (!REPOSITORY_SETTINGS_FILES.some(file => excludesBrowserLab(path.join(tree, file))))
    return { sandbox: CARD_SESSION_SANDBOX, permissions: { allow } }
  const lab = path.join(tree, BROWSER_LAB_SCRIPT)
  const labHome = path.join(os.homedir(), '.construct', 'browser-lab')
  return {
    sandbox: { ...CARD_SESSION_SANDBOX, excludedCommands: [BROWSER_LAB_EXCLUDED_COMMAND], filesystem: { denyWrite: [lab, labHome] } },
    permissions: { allow, deny: [`Edit(/${lab})`, `Edit(/${labHome}/**)`] },
  }
}

export function settingsFlag(settings: ShiftSettings): string[] {
  return ['--setting-sources', 'project,local', '--settings', JSON.stringify(settings)]
}
