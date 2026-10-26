import type { ShiftGate } from '../../src/manifest.js'

export interface ShiftSettings {
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false }
  permissions: { allow: string[] }
}

export function shiftSettings(tree: string, gate: ShiftGate, writable: string[] = []): ShiftSettings {
  return {
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
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
  return ['--settings', JSON.stringify(settings)]
}
