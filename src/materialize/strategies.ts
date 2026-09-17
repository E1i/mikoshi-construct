export type Strategy = 'create' | 'merge-json' | 'append-block'

const MERGE_JSON = new Set(['package.json'])
const APPEND_BLOCK = new Set(['.gitignore', 'CLAUDE.md', 'AGENTS.md'])

export const BLOCK_BEGIN = '<!-- construct:begin -->'
export const BLOCK_END = '<!-- construct:end -->'
const GITIGNORE_BEGIN = '# construct:begin'
const GITIGNORE_END = '# construct:end'

export function strategyFor(target: string): Strategy {
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

export function blockMarkers(target: string): [string, string] {
  return target.endsWith('.gitignore') ? [GITIGNORE_BEGIN, GITIGNORE_END] : [BLOCK_BEGIN, BLOCK_END]
}

const DISCOVERY_OPEN = /<!-- construct:discover:([\w-]+) -->/g

function discoveryBlock(document: string, marker: string): { start: number, end: number, body: string } | null {
  const open = `<!-- construct:discover:${marker} -->`
  const close = `<!-- /construct:discover:${marker} -->`
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

export function substituteBlock(existing: string, produced: string, target: string): string {
  const [begin, end] = blockMarkers(target)
  const opening = existing.indexOf(begin) + begin.length
  const closing = existing.indexOf(end)
  const incoming = produced.slice(produced.indexOf(begin) + begin.length, produced.indexOf(end))
  return `${existing.slice(0, opening)}${preserveDiscovery(existing, incoming)}${existing.slice(closing)}`
}

function withoutSecondH1(existing: string, block: string): string {
  if (existing.trim() === '' || !/^# /m.test(existing))
    return block
  return block.replace(/^# (.*)$/m, '## $1')
}

export function appendBlock(existing: string, block: string, target: string): string {
  const [begin, end] = blockMarkers(target)
  const wrapped = `${begin}\n${preserveDiscovery(existing, withoutSecondH1(existing, block)).trimEnd()}\n${end}\n`
  const start = existing.indexOf(begin)
  const stop = existing.indexOf(end)
  if (start !== -1 && stop !== -1 && stop > start)
    return `${existing.slice(0, start)}${wrapped}${existing.slice(stop + end.length).replace(/^\n/, '')}`
  const separator = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${wrapped}`
}
