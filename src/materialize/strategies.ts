import { isDeepStrictEqual } from 'node:util'

export type Strategy = 'create' | 'merge-json' | 'append-block' | 'merge-hooks'

const MERGE_JSON = new Set(['package.json'])
const APPEND_BLOCK = new Set(['.gitignore', 'CLAUDE.md', 'AGENTS.md'])
const MERGE_HOOKS = new Set(['.claude/settings.json'])

export const BLOCK_BEGIN = '<!-- construct:begin -->'
export const BLOCK_END = '<!-- construct:end -->'
const GITIGNORE_BEGIN = '# construct:begin'
const GITIGNORE_END = '# construct:end'

export function strategyFor(target: string): Strategy {
  if (MERGE_HOOKS.has(target))
    return 'merge-hooks'
  const basename = target.split('/').at(-1) ?? target
  if (MERGE_JSON.has(basename))
    return 'merge-json'
  if (APPEND_BLOCK.has(basename))
    return 'append-block'
  return 'create'
}

type JsonObject = Record<string, unknown>

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

export function mergeJson(existing: JsonObject, incoming: JsonObject, conflicts: string[], prefix = ''): JsonObject {
  const result: JsonObject = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    const at = prefix === '' ? key : `${prefix}.${key}`
    if (!(key in existing)) {
      result[key] = value
      continue
    }
    const current = existing[key]
    if (isJsonObject(current) && isJsonObject(value)) {
      result[key] = mergeJson(current, value, conflicts, at)
      continue
    }
    if (JSON.stringify(current) !== JSON.stringify(value))
      conflicts.push(at)
  }
  return result
}

export function appendHookEntry(hooks: JsonObject, event: string, entry: JsonObject): boolean {
  const created = !(event in hooks)
  hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), entry]
  return created
}

function hookCommands(element: unknown): string[] {
  if (!isJsonObject(element) || !Array.isArray(element.hooks))
    return []
  return element.hooks.flatMap(hook => isJsonObject(hook) && typeof hook.command === 'string' ? [hook.command] : [])
}

function parsedOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return null
  }
}

function excludedCommandsOf(settings: JsonObject): unknown[] | null {
  if (!('sandbox' in settings))
    return []
  const sandbox = settings.sandbox
  if (!isJsonObject(sandbox))
    return null
  if (!('excludedCommands' in sandbox))
    return []
  return Array.isArray(sandbox.excludedCommands) ? sandbox.excludedCommands : null
}

function mergedSandbox(settings: JsonObject, produced: JsonObject): JsonObject | null {
  const present = excludedCommandsOf(settings)
  const incoming = excludedCommandsOf(produced)
  if (present === null || incoming === null)
    return null
  const added = incoming.filter(command => !present.includes(command))
  if (added.length === 0)
    return settings
  const sandbox = isJsonObject(settings.sandbox) ? settings.sandbox : {}
  return { ...settings, sandbox: { ...sandbox, excludedCommands: [...present, ...added] } }
}

export function mergeHookSettings(existing: string, incoming: string): string | null {
  const parsed = parsedOrNull(existing)
  const produced = parsedOrNull(incoming)
  if (!isJsonObject(parsed) || !isJsonObject(produced) || !isJsonObject(produced.hooks))
    return null
  if ('hooks' in parsed && !isJsonObject(parsed.hooks))
    return null
  const settings = mergedSandbox(parsed, produced)
  if (settings === null)
    return null
  const hooks: JsonObject = isJsonObject(parsed.hooks) ? structuredClone(parsed.hooks) : {}
  const events = Object.entries(produced.hooks)
  if (events.some(([event, entries]) => !Array.isArray(entries) || (event in hooks && !Array.isArray(hooks[event]))))
    return null
  for (const [event, entries] of events) {
    for (const entry of entries as unknown[]) {
      const present = new Set((Array.isArray(hooks[event]) ? hooks[event] : []).flatMap(hookCommands))
      if (isJsonObject(entry) && !hookCommands(entry).every(command => present.has(command)))
        appendHookEntry(hooks, event, entry)
    }
  }
  return `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`
}

export function carriesHookSettings(existing: string, incoming: string): boolean {
  const merged = mergeHookSettings(existing, incoming)
  return merged !== null && isDeepStrictEqual(JSON.parse(merged), JSON.parse(existing))
}

const GITIGNORE_SYNTAX = new Set(['.gitignore', 'exclude'])

export function blockMarkers(target: string): [string, string] {
  const basename = target.split('/').at(-1) ?? target
  return GITIGNORE_SYNTAX.has(basename) ? [GITIGNORE_BEGIN, GITIGNORE_END] : [BLOCK_BEGIN, BLOCK_END]
}

const DISCOVERY_OPEN = /<!-- construct:discover:([\w-]+) -->/g

export function discoveryTags(marker: string): [string, string] {
  return [`<!-- construct:discover:${marker} -->`, `<!-- /construct:discover:${marker} -->`]
}

function discoveryBlock(document: string, marker: string): { start: number, end: number, body: string } | null {
  const [open, close] = discoveryTags(marker)
  const start = document.indexOf(open)
  const end = document.indexOf(close)
  if (start === -1 || end === -1 || end < start)
    return null
  return { start: start + open.length, end, body: document.slice(start + open.length, end) }
}

export function withoutDiscoveryBodies(document: string): string {
  let result = document
  for (const [, marker] of document.matchAll(DISCOVERY_OPEN)) {
    const block = discoveryBlock(result, marker)
    if (block == null)
      continue
    result = `${result.slice(0, block.start)}${result.slice(block.end)}`
  }
  return result
}

export function preserveDiscovery(existing: string, incoming: string): string {
  let result = incoming
  for (const [, marker] of existing.matchAll(DISCOVERY_OPEN)) {
    const previous = discoveryBlock(existing, marker)
    const next = discoveryBlock(result, marker)
    if (previous == null || next == null || previous.body.trim() === '' || previous.body.includes('_Not discovered yet'))
      continue
    result = `${result.slice(0, next.start)}${previous.body}${result.slice(next.end)}`
  }
  return result
}

export function discoveryTheTemplateDropped(existing: string, incoming: string): string {
  const carried = [...existing.matchAll(DISCOVERY_OPEN)].flatMap(([, marker]) => {
    const previous = discoveryBlock(existing, marker)
    if (previous == null || discoveryBlock(incoming, marker) != null || previous.body.trim() === '' || previous.body.includes('_Not discovered yet'))
      return []
    const [open, close] = discoveryTags(marker)
    return [`${open}${previous.body}${close}`]
  })
  return carried.join('\n\n')
}

export function substituteBlock(existing: string, produced: string, target: string): string {
  const [begin, end] = blockMarkers(target)
  const opening = existing.indexOf(begin) + begin.length
  const closing = existing.indexOf(end)
  const incoming = produced.slice(produced.indexOf(begin) + begin.length, produced.indexOf(end))
  const dropped = discoveryTheTemplateDropped(existing.slice(opening, closing), incoming)
  const afterEnd = closing + end.length
  return `${existing.slice(0, opening)}${preserveDiscovery(existing, incoming)}${existing.slice(closing, afterEnd)}${dropped === '' ? '' : `\n\n${dropped}`}${existing.slice(afterEnd)}`
}

function withoutSecondH1(existing: string, block: string): string {
  if (existing.trim() === '' || !/^# /m.test(existing))
    return block
  return block.replace(/^# (.*)$/m, '## $1')
}

function outsideTheConstructBlock(existing: string, target: string): string {
  const [begin, end] = blockMarkers(target)
  const start = existing.indexOf(begin)
  const stop = existing.indexOf(end)
  if (start === -1 || stop === -1 || stop <= start)
    return existing
  return `${existing.slice(0, start)}${existing.slice(stop + end.length)}`
}

export type BlockSeparator = 0 | 1 | 2

export interface AppendedBlock {
  content: string
  separator: BlockSeparator
}

function separatorBefore(existing: string): BlockSeparator {
  if (existing.length === 0 || existing.endsWith('\n\n'))
    return 0
  return existing.endsWith('\n') ? 1 : 2
}

export function appendBlockWith(existing: string, block: string, target: string): AppendedBlock {
  const [begin, end] = blockMarkers(target)
  const wrapped = `${begin}\n${preserveDiscovery(existing, withoutSecondH1(outsideTheConstructBlock(existing, target), block)).trimEnd()}\n${end}\n`
  const start = existing.indexOf(begin)
  const stop = existing.indexOf(end)
  if (start !== -1 && stop !== -1 && stop > start) {
    const dropped = discoveryTheTemplateDropped(existing.slice(start, stop), wrapped)
    return { content: `${existing.slice(0, start)}${wrapped}${dropped === '' ? '' : `\n${dropped}\n`}${existing.slice(stop + end.length).replace(/^\n/, '')}`, separator: 0 }
  }
  const separator = separatorBefore(existing)
  return { content: `${existing}${'\n'.repeat(separator)}${wrapped}`, separator }
}

export function appendBlock(existing: string, block: string, target: string): string {
  return appendBlockWith(existing, block, target).content
}

export function isBlockSeparator(value: unknown): value is BlockSeparator {
  return value === 0 || value === 1 || value === 2
}

export function removeBlock(existing: string, target: string, separator: BlockSeparator): string | null {
  const [begin, end] = blockMarkers(target)
  const start = existing.indexOf(begin)
  const stop = existing.indexOf(end)
  if (start === -1 || stop === -1 || stop < start)
    return existing
  if (start < separator || existing.slice(start - separator, start) !== '\n'.repeat(separator))
    return null
  const before = existing.slice(0, start - separator)
  if (separatorBefore(before) !== separator)
    return null
  const after = existing.slice(stop + end.length).replace(/^\n/, '')
  return `${before}${after}`
}
