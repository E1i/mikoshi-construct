import type { BusSection } from './factory/bus.js'
import type { Axis } from './factory/concepts.js'
import type { PortModule } from './factory/ports.js'
import path from 'node:path'
import { busSection } from './factory/bus.js'
import { CONCEPTS } from './factory/concepts.js'
import { findSites, overlapsSection } from './factory/overlaps.js'
import { portsSection } from './factory/ports.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

export const FACTORY_VERSION = 1

export interface FactoryConcept {
  title: string
  owner: string
  ownerExists: boolean
  axis: Axis
}

export interface Factory {
  factoryVersion: number
  ports: Record<string, PortModule>
  bus: BusSection
  concepts: Record<string, FactoryConcept>
  overlaps: Record<string, Record<string, number>>
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function conceptsSection(): Record<string, FactoryConcept> {
  return Object.fromEntries(CONCEPTS.map(({ id, title, owner, ownerExists, axis }) => [id, { title, owner, ownerExists, axis }]))
}

export function generateFactory(root: string = REPO_ROOT): Factory {
  return {
    factoryVersion: FACTORY_VERSION,
    ports: portsSection(root),
    bus: busSection(root),
    concepts: conceptsSection(),
    overlaps: overlapsSection(findSites(root)),
  }
}

function sortedKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(sortedKeys)
  if (value != null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key]!)]))
  return value
}

export function renderFactory(factory: Factory): string {
  return `${JSON.stringify(sortedKeys(factory as unknown as JsonValue), null, 2)}\n`
}
