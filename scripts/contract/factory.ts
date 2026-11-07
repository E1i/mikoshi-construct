import type { BusSection } from './factory/bus.js'
import type { Axis, Concept } from './factory/concepts.js'
import type { PortModule } from './factory/ports.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { clientAdapter } from '../ports/client/index.js'
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

export const PORT_LANGUAGES = ['factory', 'technology'] as const

export type PortLanguage = typeof PORT_LANGUAGES[number]

export const TECHNOLOGY_WORDS: ReadonlySet<string> = new Set([
  clientAdapter().id,
  'argv',
  'bwrap',
  'database',
  'endpoint',
  'errno',
  'exec',
  'gh',
  'git',
  'grep',
  'headers',
  'http',
  'https',
  'lsof',
  'pnpm',
  'porcelain',
  'shell',
  'socat',
  'spawn',
  'sqlite',
  'statfs',
  'stderr',
  'stdout',
])

export interface FactoryPort extends PortModule {
  language: PortLanguage
  technologyWords: string[]
}

export interface Factory {
  factoryVersion: number
  ports: Record<string, FactoryPort>
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

function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word !== '')
}

function surfaceText({ functions, types, constants, reexports }: PortModule): string {
  return [...Object.entries(functions).flat(), ...Object.entries(types).flat(), ...constants, ...reexports].join(' ')
}

export function portLanguage(module: PortModule): FactoryPort {
  const technologyWords = [...new Set(wordsOf(surfaceText(module)))].filter(word => TECHNOLOGY_WORDS.has(word)).sort()
  return { ...module, language: technologyWords.length === 0 ? 'factory' : 'technology', technologyWords }
}

function markedPorts(ports: Record<string, PortModule>): Record<string, FactoryPort> {
  return Object.fromEntries(Object.entries(ports).map(([file, module]) => [file, portLanguage(module)]))
}

function acceptedConcepts(root: string): AcceptedConcepts {
  const { concepts } = JSON.parse(readFileSync(path.join(root, ACCEPTED_MODEL), 'utf8')) as { concepts: AcceptedConcepts }
  return concepts
}

export function generateFactory(root: string = REPO_ROOT): Factory {
  return {
    factoryVersion: FACTORY_VERSION,
    ports: markedPorts(portsSection(root)),
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
