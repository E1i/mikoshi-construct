import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { MANIFEST_FILE } from '../../../src/manifest.js'

export const SHARED_APPEND_FIELD = 'sharedAppendFiles'

export function sharedAppendFiles(root: string = process.cwd()): string[] {
  const file = path.join(root, MANIFEST_FILE)
  if (!existsSync(file))
    return []
  try {
    const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null)?.[SHARED_APPEND_FIELD]
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
  }
  catch {
    return []
  }
}
