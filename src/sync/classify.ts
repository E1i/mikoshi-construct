import type { Strategy } from '../materialize/strategies.js'
import type { TemplateVariant } from '../materialize/templates.js'
import type { OwnedKey } from './ownership.js'
import type { EstablishedVariant } from './variant.js'
import { strategyFor } from '../materialize/strategies.js'
import { blockSpansDocument, carriesConstructBlock, matchesRecordedSha, ownedKeys, ownedText } from './ownership.js'

export const PATH_CLASSES = ['add', 'keep', 'update', 'conflict', 'unknown', 'removed', 'orphaned', 'foreign'] as const

export type PathClass = (typeof PATH_CLASSES)[number]

export const BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER = 'block-replaced-whole-discovery-bodies-carried-over'

export type WriteEffect = typeof BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER

export interface PathState {
  target: string
  recordedSha: string | null
  present: string | null
  produced: string | null
  variant?: EstablishedVariant | null
}

export interface PathClassification {
  target: string
  strategy: Strategy
  class: PathClass
  keys: OwnedKey[]
  writeEffect: WriteEffect | null
  variant?: EstablishedVariant | null
  shape?: TemplateVariant
}

export interface RepositoryState {
  recorded: Record<string, string>
  present: Record<string, string>
  produced: Record<string, string>
  variants?: Record<string, EstablishedVariant>
}

function classFromKeys(keys: OwnedKey[]): PathClass {
  if (keys.some(key => key.class === 'conflict'))
    return 'conflict'
  return keys.some(key => key.class === 'add') ? 'update' : 'keep'
}

function compareDeclaredBlock(target: string, present: string, produced: string, variant: EstablishedVariant | null): PathClass {
  if (!carriesConstructBlock(target, present))
    return 'conflict'
  if (variant == null)
    return 'unknown'
  return ownedText(target, present) === ownedText(target, produced) ? 'keep' : 'update'
}

function shapeSuggests(target: string, present: string): TemplateVariant {
  return blockSpansDocument(target, present) ? 'default' : 'existing'
}

function compareOwnedView(target: string, recordedSha: string, present: string, produced: string): PathClass {
  if (ownedText(target, present) === ownedText(target, produced))
    return 'keep'
  if (matchesRecordedSha(recordedSha, target, present))
    return 'update'
  return 'conflict'
}

export function classifyPath(state: PathState): PathClassification | null {
  const { target, recordedSha, present, produced } = state
  const variant = state.variant ?? null
  const strategy = strategyFor(target)
  const classified = (value: PathClass, keys: OwnedKey[] = []): PathClassification => ({
    target,
    strategy,
    class: value,
    keys,
    writeEffect: writeEffectFor(strategy, value),
    ...(strategy === 'append-block' ? { variant } : {}),
    ...(value === 'unknown' && present != null ? { shape: shapeSuggests(target, present) } : {}),
  })

  if (present == null) {
    if (recordedSha != null)
      return classified('removed')
    return produced == null ? null : classified('add')
  }

  if (produced == null)
    return classified(recordedSha == null ? 'foreign' : 'orphaned')

  if (strategy === 'merge-json') {
    const keys = ownedKeys(present, produced)
    if (keys == null)
      return classified('conflict')
    return classified(recordedSha == null ? 'conflict' : classFromKeys(keys), keys)
  }

  if (recordedSha == null)
    return classified('conflict')

  if (strategy === 'append-block')
    return classified(compareDeclaredBlock(target, present, produced, variant))

  return classified(compareOwnedView(target, recordedSha, present, produced))
}

const WRITABLE_CLASSES = new Set<PathClass>(['add', 'update'])
const WRITABLE_STRATEGIES = new Set<Strategy>(['create', 'append-block'])

function willBeWritten(strategy: Strategy, value: PathClass): boolean {
  return WRITABLE_CLASSES.has(value) && WRITABLE_STRATEGIES.has(strategy)
}

function writeEffectFor(strategy: Strategy, value: PathClass): WriteEffect | null {
  return strategy === 'append-block' && willBeWritten(strategy, value) ? BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER : null
}

export function isWritable(classification: PathClassification): boolean {
  return willBeWritten(classification.strategy, classification.class)
}

export function classifyRepository(state: RepositoryState): PathClassification[] {
  const targets = [...new Set([...Object.keys(state.recorded), ...Object.keys(state.present), ...Object.keys(state.produced)])].sort()
  return targets.flatMap((target) => {
    const classification = classifyPath({
      target,
      recordedSha: state.recorded[target] ?? null,
      present: state.present[target] ?? null,
      produced: state.produced[target] ?? null,
      variant: state.variants?.[target] ?? null,
    })
    return classification == null ? [] : [classification]
  })
}
