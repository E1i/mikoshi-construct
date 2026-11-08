import type { BusSection } from './factory/bus.js'
import type { CardSection } from './factory/card.js'
import type { Axis, Concept } from './factory/concepts.js'
import type { NodesSection } from './factory/nodes.js'
import type { PortModule, PortsSection } from './factory/ports.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { FACTORY_FOLDERS } from '../core/factory-paths.js'
import { clientAdapter } from '../ports/client/index.js'
import { busSection } from './factory/bus.js'
import { cardSection } from './factory/card.js'
import { assertNoLoreConflict, CONCEPTS } from './factory/concepts.js'
import { nodesSection } from './factory/nodes.js'
import { findSites, overlapsSection } from './factory/overlaps.js'
import { portsSection } from './factory/ports.js'
import { parsedFiles } from './factory/walk.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const ACCEPTED_MODEL = 'contract/accepted.json'
const DECISION_ID = /^D-\d+$/
const PORTS_TREE = FACTORY_FOLDERS.sharedCode.find(folder => folder.endsWith('/ports'))!

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
  lore: string | null
  status: ConceptStatus
}

export const PORT_LANGUAGES = ['factory', 'technology'] as const

export type PortLanguage = typeof PORT_LANGUAGES[number]

export const DECLARED_WORDS = 'TECHNOLOGY_WORDS'

export interface FactoryPort extends PortModule {
  language: PortLanguage
  technologyWords: string[]
}

export interface FactoryPorts extends Omit<PortsSection, 'modules'> {
  modules: Record<string, FactoryPort>
}

export interface Factory {
  factoryVersion: number
  ports: FactoryPorts
  bus: BusSection
  card: CardSection
  nodes: NodesSection
  concepts: Record<string, FactoryConcept>
  overlaps: Record<string, Record<string, number>>
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function ratifiedOwnerStatus({ id, owner }: Concept, accepted: AcceptedConcepts): ConceptStatus {
  const entry = accepted[id]
  return entry?.owner === owner && DECISION_ID.test(entry.decision) ? 'accepted' : 'proposed'
}

export function conceptsSection(accepted: AcceptedConcepts, concepts: readonly Concept[] = CONCEPTS): Record<string, FactoryConcept> {
  assertNoLoreConflict(concepts)
  return Object.fromEntries(concepts.map((concept) => {
    const { id, title, owner, ownerExists, axis, lore } = concept
    return [id, { title, owner, ownerExists, axis, lore, status: ratifiedOwnerStatus(concept, accepted) }]
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

function listedLiteral(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) ? listedLiteral(expression.expression) : expression
}

function declaredIn(statement: ts.Statement): string[] {
  if (!ts.isVariableStatement(statement) || !(ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false))
    return []
  return statement.declarationList.declarations.flatMap((declaration) => {
    const value = declaration.initializer === undefined ? undefined : listedLiteral(declaration.initializer)
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== DECLARED_WORDS || value === undefined || !ts.isArrayLiteralExpression(value))
      return []
    return value.elements.filter(ts.isStringLiteral).map(element => element.text)
  })
}

export function technologyVocabulary(root: string = REPO_ROOT): ReadonlySet<string> {
  const declared = parsedFiles(root, [PORTS_TREE]).flatMap(({ source }) => source.statements.flatMap(declaredIn))
  return new Set([clientAdapter().id, ...declared])
}

export function portLanguage(module: PortModule, vocabulary: ReadonlySet<string>): FactoryPort {
  const technologyWords = [...new Set(wordsOf(surfaceText(module)))].filter(word => vocabulary.has(word)).sort()
  return { ...module, language: technologyWords.length === 0 ? 'factory' : 'technology', technologyWords }
}

function markedPorts({ modules, ...versioned }: PortsSection, vocabulary: ReadonlySet<string>): FactoryPorts {
  return { ...versioned, modules: Object.fromEntries(Object.entries(modules).map(([file, module]) => [file, portLanguage(module, vocabulary)])) }
}

function acceptedConcepts(root: string): AcceptedConcepts {
  const { concepts } = JSON.parse(readFileSync(path.join(root, ACCEPTED_MODEL), 'utf8')) as { concepts: AcceptedConcepts }
  return concepts
}

export function generateFactory(root: string = REPO_ROOT): Factory {
  return {
    factoryVersion: FACTORY_VERSION,
    ports: markedPorts(portsSection(root), technologyVocabulary(root)),
    bus: busSection(root),
    card: cardSection(root),
    nodes: nodesSection(),
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
