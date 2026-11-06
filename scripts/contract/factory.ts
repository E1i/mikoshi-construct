import type { BusSection } from './factory/bus.js'
import type { Axis, Concept } from './factory/concepts.js'
import type { PortModule } from './factory/ports.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { busSection } from './factory/bus.js'
import { CONCEPTS } from './factory/concepts.js'
import { findSites, overlapsSection } from './factory/overlaps.js'
import { portsSection } from './factory/ports.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const ACCEPTED_MODEL = 'contract/accepted.json'
const DECISION_ID = /^D-\d+$/

export const FACTORY_VERSION = 1

export type ConceptStatus = 'accepted' | 'proposed'

export interface AcceptedConcept {
  owner: string
  decision: string
}

export type AcceptedConcepts = Readonly<Record<string, AcceptedConcept>>

export interface FactoryConcept {
  title: string
  owner: string
  ownerExists: boolean
  axis: Axis
  status: ConceptStatus
}

export interface Factory {
  factoryVersion: number
  ports: Record<string, PortModule>
  bus: BusSection
  concepts: Record<string, FactoryConcept>
  overlaps: Record<string, Record<string, number>>
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function ratifiedOwnerStatus({ id, owner }: Concept, accepted: AcceptedConcepts): ConceptStatus {
  const entry = accepted[id]
  return entry?.owner === owner && DECISION_ID.test(entry.decision) ? 'accepted' : 'proposed'
}

export function conceptsSection(accepted: AcceptedConcepts): Record<string, FactoryConcept> {
  return Object.fromEntries(CONCEPTS.map((concept) => {
    const { id, title, owner, ownerExists, axis } = concept
    return [id, { title, owner, ownerExists, axis, status: ratifiedOwnerStatus(concept, accepted) }]
  }))
}

function acceptedConcepts(root: string): AcceptedConcepts {
  const { concepts } = JSON.parse(readFileSync(path.join(root, ACCEPTED_MODEL), 'utf8')) as { concepts: AcceptedConcepts }
  return concepts
}

export function generateFactory(root: string = REPO_ROOT): Factory {
  return {
    factoryVersion: FACTORY_VERSION,
    ports: portsSection(root),
    bus: busSection(root),
    concepts: conceptsSection(acceptedConcepts(root)),
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
