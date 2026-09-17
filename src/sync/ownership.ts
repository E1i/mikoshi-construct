import { sha256 } from '../manifest.js'
import { blockMarkers, isJsonObject, strategyFor, withoutDiscoveryBodies } from '../materialize/strategies.js'

export type KeyClass = 'add' | 'keep' | 'conflict'

export interface OwnedKey {
  key: string
  class: KeyClass
}

export function ownedText(target: string, content: string): string {
  if (strategyFor(target) !== 'append-block')
    return content
  if (!carriesConstructBlock(target, content))
    return ''
  const [begin, end] = blockMarkers(target)
  return withoutDiscoveryBodies(content.slice(content.indexOf(begin) + begin.length, content.indexOf(end)))
}

export function carriesConstructBlock(target: string, content: string): boolean {
  const [begin, end] = blockMarkers(target)
  const start = content.indexOf(begin)
  const stop = content.indexOf(end)
  return start !== -1 && stop > start
}

export function ownedSha(target: string, content: string): string {
  return sha256(ownedText(target, content))
}

export function matchesRecordedSha(recorded: string, target: string, content: string): boolean {
  const asOwnedViewWrittenBySync = ownedSha(target, content)
  const asWholeFileWrittenByInit = sha256(content)
  return recorded === asOwnedViewWrittenBySync || recorded === asWholeFileWrittenByInit
}

function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown
    return isJsonObject(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

function compareKeys(present: Record<string, unknown>, produced: Record<string, unknown>, prefix: string): OwnedKey[] {
  const owned: OwnedKey[] = []
  for (const [key, value] of Object.entries(produced)) {
    const at = prefix === '' ? key : `${prefix}.${key}`
    if (!(key in present)) {
      owned.push({ key: at, class: 'add' })
      continue
    }
    const current = present[key]
    if (isJsonObject(current) && isJsonObject(value)) {
      owned.push(...compareKeys(current, value, at))
      continue
    }
    owned.push({ key: at, class: JSON.stringify(current) === JSON.stringify(value) ? 'keep' : 'conflict' })
  }
  return owned
}

export function ownedKeys(present: string, produced: string): OwnedKey[] | null {
  const current = parseObject(present)
  const template = parseObject(produced)
  if (current == null || template == null)
    return null
  return compareKeys(current, template, '')
}
