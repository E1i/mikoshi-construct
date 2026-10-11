import type { EntryCommand } from './command.js'
import path from 'node:path'
import { parseJsonc } from '../imports/jsonc.js'
import { isRecord } from '../imports/specifiers.js'
import { cursorOver } from './json-lines.js'

const MANIFEST = 'package.json'

export function declaresScripts(file: string): boolean {
  return path.posix.basename(file) === MANIFEST
}

export function packageScripts(file: string, text: string): EntryCommand[] {
  const manifest = parseJsonc(text)
  if (!isRecord(manifest) || !isRecord(manifest.scripts))
    return []
  const next = cursorOver(text)
  const scriptsLine = next('"scripts"')
  return Object.entries(manifest.scripts).flatMap(([name, command]) => {
    if (typeof command !== 'string')
      return []
    return [{ name, command, line: next(JSON.stringify(name)) ?? scriptsLine ?? 1, cwd: path.posix.dirname(file) }]
  })
}
