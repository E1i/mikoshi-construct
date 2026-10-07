import type { Buffer } from 'node:buffer'
import type { SettingsHook, SettingsOriginal } from '../attach/settings.js'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isConfinedCopy, sha256OfBytes } from '../attach/original.js'
import { removeGuardEntry, SETTINGS_FILE, writeSettingsBytes } from '../attach/settings.js'

export type OriginalCheck
  = | { kind: 'matched', bytes: Buffer }
    | { kind: 'refused' }

export function checkOriginal(original: SettingsOriginal): OriginalCheck {
  if (!isConfinedCopy(original.copy))
    return { kind: 'refused' }
  try {
    if (!lstatSync(original.copy).isFile())
      return { kind: 'refused' }
    const bytes = readFileSync(original.copy)
    return sha256OfBytes(bytes) === original.sha256 ? { kind: 'matched', bytes } : { kind: 'refused' }
  }
  catch {
    return { kind: 'refused' }
  }
}

function untouchedSinceAttach(root: string, original: SettingsOriginal): boolean {
  try {
    return sha256OfBytes(readFileSync(path.join(root, SETTINGS_FILE))) === original.afterSha256
  }
  catch {
    return false
  }
}

export function takeOutGuardEntry(root: string, hook: SettingsHook, check: OriginalCheck | null): { settingsDeleted: boolean, entryCutOut: boolean, bytesRestored: boolean } {
  if (hook.original != null && check?.kind === 'matched' && untouchedSinceAttach(root, hook.original)) {
    writeSettingsBytes(root, check.bytes)
    return { settingsDeleted: false, entryCutOut: false, bytesRestored: true }
  }
  const settingsDeleted = removeGuardEntry(root, hook).fileDeleted
  return { settingsDeleted, entryCutOut: !settingsDeleted, bytesRestored: false }
}
