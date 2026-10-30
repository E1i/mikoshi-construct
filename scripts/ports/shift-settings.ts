import type { ShiftGate } from '../../src/manifest.js'

export const CARD_SESSION_SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true } } as const

export interface ShiftSettings {
  sandbox: typeof CARD_SESSION_SANDBOX
  permissions: { allow: string[] }
}

export function shiftSettings(tree: string, gate: ShiftGate, writable: string[] = []): ShiftSettings {
  return {
    sandbox: CARD_SESSION_SANDBOX,
    permissions: {
      allow: [
        ...gate.prepush.map(command => `Bash(${command})`),
        `Edit(/${tree}/**)`,
        ...writable.map(file => `Edit(/${file})`),
      ],
    },
  }
}

export function settingsFlag(settings: ShiftSettings): string[] {
  return ['--setting-sources', 'project,local', '--settings', JSON.stringify(settings)]
}
