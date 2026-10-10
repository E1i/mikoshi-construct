import type { EntryCommand } from './command.js'
import path from 'node:path'
import { parseJsonc } from '../imports/jsonc.js'
import { isRecord } from '../imports/specifiers.js'
import { cursorOver } from './json-lines.js'

const SETTINGS = /(?:^|\/)\.claude\/settings\.json$/
const EVERY_TOOL = '*'

export function declaresHooks(file: string): boolean {
  return SETTINGS.test(file)
}

function nameOf(event: string, matcher: unknown): string {
  return typeof matcher === 'string' && matcher !== '' && matcher !== EVERY_TOOL ? `${event} ${matcher}` : event
}

export function settingsHooks(file: string, text: string): EntryCommand[] {
  const settings = parseJsonc(text)
  if (!isRecord(settings) || !isRecord(settings.hooks))
    return []
  const next = cursorOver(text)
  const hooksLine = next('"hooks"') ?? 1
  const cwd = path.posix.dirname(path.posix.dirname(file))
  return Object.entries(settings.hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks))
      return []
    return group.hooks.flatMap((hook) => {
      if (!isRecord(hook) || typeof hook.command !== 'string')
        return []
      return [{ name: nameOf(event, group.matcher), command: hook.command, line: next(JSON.stringify(hook.command)) ?? hooksLine, cwd }]
    })
  }))
}
