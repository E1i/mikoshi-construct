import { RecordAheadOfReader } from '../record-ahead.js'

export const MODEL_FILE = 'construct.model.json'
export const MODEL_VERSION = 6
const OLDEST_READABLE_MODEL_VERSION = 1

export const FACT_KINDS = ['file-exists', 'file-contains', 'file-lacks', 'report-covers', 'report-misses'] as const
export type FactKind = (typeof FACT_KINDS)[number]

const NEEDLE_KINDS: readonly FactKind[] = ['file-contains', 'file-lacks']
export const REPORT_KINDS: readonly FactKind[] = ['report-covers', 'report-misses']

export const REPORT_FORMATS = ['vitest-json', 'junit-xml'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

export const ENFORCEMENT_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number]

export const ENTRY_AUTHORS = ['construct', 'discovery', 'unknown'] as const
export type EntryAuthor = (typeof ENTRY_AUTHORS)[number]

export interface Fact {
  id: string
  kind: FactKind
  path: string
  authoredBy: EntryAuthor
  needle?: string
  surface?: string[]
  format?: ReportFormat
}

export interface Enforcement {
  mechanism: string
  level: EnforcementLevel
  supportedBy: string[]
}

export interface Verification {
  mechanism: string
  supportedBy: string[]
}

export interface Claim {
  id: string
  statement: string
  authoredBy: EntryAuthor
  enforcement: Enforcement | null
  verification: Verification | null
  checkId?: string
}

export interface Hypothesis {
  id: string
  statement: string
  authoredBy: EntryAuthor
  baseSha: string | null
  evidenceClean: boolean
  supportedBy: string[]
}

export interface Stage {
  id: string
  label: string
}

export type NodeSource = { path: string } | { fact: string }

export interface AbilityNode {
  id: string
  label: string
  stage: string
  source: NodeSource
  supportedBy: string[]
}

export interface Link {
  from: string
  to: string
}

export const RELATION_KINDS = ['imports', 'calls'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export const OBSERVED_STATUSES = ['found', 'unknown'] as const
export type ObservedStatus = (typeof OBSERVED_STATUSES)[number]

export interface CommandSource {
  command: string
  exit: number | null
  effects: string[]
}

export interface LineSource {
  path: string
  line: number
}

export interface Identity {
  sha: string | null
  status: ObservedStatus
  source: CommandSource
}

export interface Tree {
  status: ObservedStatus
  source: CommandSource
}

export const COMPONENT_REASONS = ['type-not-scanned', 'unreadable'] as const
export type ComponentReason = (typeof COMPONENT_REASONS)[number]

export type Component
  = | { id: string, path: string, relations: 'found' }
    | { id: string, path: string, relations: 'unknown', reason: ComponentReason }

export interface Relation {
  from: string
  to: string | null
  kind: RelationKind
  specifier: string
  status: ObservedStatus
  source: LineSource
}

export const CONTOUR_KINDS = ['package', 'workspace', 'reference', 'contract'] as const
export type ContourKind = (typeof CONTOUR_KINDS)[number]

export interface Contour {
  id: string
  name: string
  kind: ContourKind
  declaredBy: string
  entries: string[]
}

export interface Mechanics {
  identity: Identity
  tree: Tree
  contours: Contour[]
  components: Component[]
  relations: Relation[]
}

export interface InterpretedComponent {
  id: string
  contour: string
  name: string
  purpose: string
  files: string[]
}

export interface Interpretation {
  authoredBy: EntryAuthor
  components: InterpretedComponent[]
}

export interface RepositoryModel {
  modelVersion: number
  facts: Fact[]
  claims: Claim[]
  hypotheses: Hypothesis[]
  stages: Stage[]
  nodes: AbilityNode[]
  links: Link[]
  mechanics?: Mechanics
  interpretation?: Interpretation
}

const FACT_PROPERTIES = ['id', 'kind', 'path', 'authoredBy', 'needle', 'surface', 'format']
const ENFORCEMENT_PROPERTIES = ['mechanism', 'level', 'supportedBy']
const VERIFICATION_PROPERTIES = ['mechanism', 'supportedBy']
const CLAIM_PROPERTIES = ['id', 'statement', 'authoredBy', 'enforcement', 'verification', 'checkId']
export const HYPOTHESIS_PROPERTIES = ['id', 'statement', 'authoredBy', 'baseSha', 'evidenceClean', 'supportedBy']
export const STAGE_PROPERTIES = ['id', 'label']
export const NODE_PROPERTIES = ['id', 'label', 'stage', 'source', 'supportedBy']
export const NODE_SOURCE_PROPERTIES = ['path', 'fact']
export const LINK_PROPERTIES = ['from', 'to']
export const MECHANICS_PROPERTIES = ['identity', 'tree', 'contours', 'components', 'relations']
export const CONTOUR_PROPERTIES = ['id', 'name', 'kind', 'declaredBy', 'entries']
export const INTERPRETATION_PROPERTIES = ['authoredBy', 'components']
export const INTERPRETED_COMPONENT_PROPERTIES = ['id', 'contour', 'name', 'purpose', 'files']
export const IDENTITY_PROPERTIES = ['sha', 'status', 'source']
export const TREE_PROPERTIES = ['status', 'source']
export const COMMAND_SOURCE_PROPERTIES = ['command', 'exit', 'effects']
export const LINE_SOURCE_PROPERTIES = ['path', 'line']
export const COMPONENT_PROPERTIES = ['id', 'path', 'relations', 'reason']
export const RELATION_PROPERTIES = ['from', 'to', 'kind', 'specifier', 'status', 'source']
const OPTIONAL_LISTS = ['stages', 'nodes', 'links']
const MODEL_PROPERTIES = ['modelVersion', 'facts', 'claims', 'hypotheses', 'stages', 'nodes', 'links', 'mechanics', 'interpretation']

export class DanglingFactReference extends Error {
  readonly factId: string
  readonly entry: string

  constructor(name: string, entry: string, property: string, factId: string) {
    super(`${name}: ${entry} ${property} refers to unknown fact "${factId}"`)
    this.name = 'DanglingFactReference'
    this.factId = factId
    this.entry = entry
  }
}

function fail(name: string, message: string): never {
  throw new Error(`${name}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function closed(name: string, record: Record<string, unknown>, allowed: string[], where: string): Record<string, unknown> {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key))
      fail(name, `${where} carries an unexpected property "${key}": the schema is closed`)
  }
  return record
}

function text(name: string, record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '')
    fail(name, `${where} needs a non-empty "${key}"`)
  return value
}

function optionalText(name: string, record: Record<string, unknown>, key: string, where: string): string | undefined {
  if (record[key] === undefined)
    return undefined
  return text(name, record, key, where)
}

function nullableText(name: string, record: Record<string, unknown>, key: string, where: string): string | null {
  const value = record[key]
  if (value === null)
    return null
  if (typeof value !== 'string' || value.trim() === '')
    fail(name, `${where} needs a non-empty "${key}" or null`)
  return value
}

function flag(name: string, record: Record<string, unknown>, key: string, where: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean')
    fail(name, `${where} needs a "${key}" of true or false`)
  return value
}

function member<T extends string>(name: string, value: string, values: readonly T[], key: string, where: string): T {
  if (!(values as readonly string[]).includes(value))
    fail(name, `${where} ${key} "${value}" is not one of ${values.join(', ')}`)
  return value as T
}

function list(name: string, record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = OPTIONAL_LISTS.includes(key) && !(key in record) ? [] : record[key]
  if (!Array.isArray(value) || !value.every(isRecord))
    fail(name, `"${key}" must be a list of objects`)
  return value
}

function uniqueIds(name: string, ids: string[], where: string): Set<string> {
  const unique = new Set(ids)
  if (unique.size !== ids.length)
    fail(name, `${where} ids must be unique`)
  return unique
}

function nullableRecord(name: string, record: Record<string, unknown>, key: string, where: string): Record<string, unknown> | null {
  const value = record[key]
  if (value === null)
    return null
  if (!isRecord(value))
    fail(name, `${where} needs an "${key}" object or null`)
  return value
}

function supportedBy(name: string, record: Record<string, unknown>, where: string, facts: Set<string>): string[] {
  const value = record.supportedBy
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.trim() !== ''))
    fail(name, `${where} needs a "supportedBy" list of fact ids`)
  const ids = value as string[]
  for (const id of ids) {
    if (!facts.has(id))
      throw new DanglingFactReference(name, where, 'supportedBy', id)
  }
  return ids
}

function declared(name: string, value: string, ids: Set<string>, key: string, noun: string, where: string): string {
  if (!ids.has(value))
    fail(name, `${where} ${key} "${value}" names no ${noun} this document declares`)
  return value
}

function parseSource(name: string, entry: Record<string, unknown>, where: string, facts: Set<string>): NodeSource {
  const sourceWhere = `${where}.source`
  const raw = entry.source
  const choices = NODE_SOURCE_PROPERTIES.join(', ')
  if (!isRecord(raw))
    fail(name, `${where} needs a "source" object carrying exactly one of ${choices}`)
  closed(name, raw, NODE_SOURCE_PROPERTIES, sourceWhere)
  const present = NODE_SOURCE_PROPERTIES.filter(key => raw[key] !== undefined)
  if (present.length === 0)
    fail(name, `${sourceWhere} carries none of ${choices}: it needs exactly one`)
  if (present.length > 1)
    fail(name, `${sourceWhere} carries ${present.join(' and ')}: it needs exactly one of ${choices}`)
  if (present[0] === 'path')
    return { path: text(name, raw, 'path', sourceWhere) }
  const fact = text(name, raw, 'fact', sourceWhere)
  if (!facts.has(fact))
    throw new DanglingFactReference(name, sourceWhere, 'fact', fact)
  return { fact }
}

function globs(name: string, record: Record<string, unknown>, where: string): string[] {
  const value = record.surface
  if (!Array.isArray(value) || value.length === 0 || !value.every(entry => typeof entry === 'string' && entry.trim() !== ''))
    fail(name, `${where} needs a "surface" list of non-empty globs`)
  return value as string[]
}

function parseFacts(name: string, raw: Record<string, unknown>): Fact[] {
  return list(name, raw, 'facts').map((entry, index) => {
    const where = `facts[${index}]`
    closed(name, entry, FACT_PROPERTIES, where)
    const kind = member(name, text(name, entry, 'kind', where), FACT_KINDS, 'kind', where)
    const fact: Fact = {
      id: text(name, entry, 'id', where),
      kind,
      path: text(name, entry, 'path', where),
      authoredBy: member(name, text(name, entry, 'authoredBy', where), ENTRY_AUTHORS, 'authoredBy', where),
    }
    const needle = optionalText(name, entry, 'needle', where)
    if (NEEDLE_KINDS.includes(kind)) {
      if (needle === undefined)
        fail(name, `${where} of kind "${kind}" needs a non-empty "needle"`)
      fact.needle = needle
    }
    else if (needle !== undefined) {
      fail(name, `${where} of kind "${kind}" must not carry a "needle"`)
    }
    if (REPORT_KINDS.includes(kind)) {
      fact.surface = globs(name, entry, `${where} of kind "${kind}"`)
      const format = optionalText(name, entry, 'format', where)
      if (format !== undefined)
        fact.format = member(name, format, REPORT_FORMATS, 'format', where)
    }
    else {
      if (entry.surface !== undefined)
        fail(name, `${where} of kind "${kind}" must not carry a "surface"`)
      if (entry.format !== undefined)
        fail(name, `${where} of kind "${kind}" must not carry a "format"`)
    }
    return fact
  })
}

function parseClaims(name: string, raw: Record<string, unknown>, facts: Set<string>): Claim[] {
  return list(name, raw, 'claims').map((entry, index) => {
    const where = `claims[${index}]`
    closed(name, entry, CLAIM_PROPERTIES, where)
    const enforcementEntry = nullableRecord(name, entry, 'enforcement', where)
    const verificationEntry = nullableRecord(name, entry, 'verification', where)
    const claim: Claim = {
      id: text(name, entry, 'id', where),
      statement: text(name, entry, 'statement', where),
      authoredBy: member(name, text(name, entry, 'authoredBy', where), ENTRY_AUTHORS, 'authoredBy', where),
      enforcement: enforcementEntry === null ? null : parseEnforcement(name, enforcementEntry, `${where}.enforcement`, facts),
      verification: verificationEntry === null ? null : parseVerification(name, verificationEntry, `${where}.verification`, facts),
    }
    const checkId = optionalText(name, entry, 'checkId', where)
    if (checkId !== undefined)
      claim.checkId = checkId
    return claim
  })
}

function parseEnforcement(name: string, entry: Record<string, unknown>, where: string, facts: Set<string>): Enforcement {
  closed(name, entry, ENFORCEMENT_PROPERTIES, where)
  return {
    mechanism: text(name, entry, 'mechanism', where),
    level: member(name, text(name, entry, 'level', where), ENFORCEMENT_LEVELS, 'level', where),
    supportedBy: supportedBy(name, entry, where, facts),
  }
}

function parseVerification(name: string, entry: Record<string, unknown>, where: string, facts: Set<string>): Verification {
  closed(name, entry, VERIFICATION_PROPERTIES, where)
  return {
    mechanism: text(name, entry, 'mechanism', where),
    supportedBy: supportedBy(name, entry, where, facts),
  }
}

function parseHypotheses(name: string, raw: Record<string, unknown>, facts: Set<string>): Hypothesis[] {
  return list(name, raw, 'hypotheses').map((entry, index) => {
    const where = `hypotheses[${index}]`
    closed(name, entry, HYPOTHESIS_PROPERTIES, where)
    return {
      id: text(name, entry, 'id', where),
      statement: text(name, entry, 'statement', where),
      authoredBy: member(name, text(name, entry, 'authoredBy', where), ENTRY_AUTHORS, 'authoredBy', where),
      baseSha: nullableText(name, entry, 'baseSha', where),
      evidenceClean: flag(name, entry, 'evidenceClean', where),
      supportedBy: supportedBy(name, entry, where, facts),
    }
  })
}

function parseStages(name: string, raw: Record<string, unknown>): Stage[] {
  return list(name, raw, 'stages').map((entry, index) => {
    const where = `stages[${index}]`
    closed(name, entry, STAGE_PROPERTIES, where)
    return { id: text(name, entry, 'id', where), label: text(name, entry, 'label', where) }
  })
}

function parseNodes(name: string, raw: Record<string, unknown>, facts: Set<string>, stages: Set<string>): AbilityNode[] {
  return list(name, raw, 'nodes').map((entry, index) => {
    const where = `nodes[${index}]`
    closed(name, entry, NODE_PROPERTIES, where)
    return {
      id: text(name, entry, 'id', where),
      label: text(name, entry, 'label', where),
      stage: declared(name, text(name, entry, 'stage', where), stages, 'stage', 'stage', where),
      source: parseSource(name, entry, where, facts),
      supportedBy: supportedBy(name, entry, where, facts),
    }
  })
}

function parseLinks(name: string, raw: Record<string, unknown>, nodes: Set<string>): Link[] {
  return list(name, raw, 'links').map((entry, index) => {
    const where = `links[${index}]`
    closed(name, entry, LINK_PROPERTIES, where)
    return {
      from: declared(name, text(name, entry, 'from', where), nodes, 'from', 'node', where),
      to: declared(name, text(name, entry, 'to', where), nodes, 'to', 'node', where),
    }
  })
}

function textList(name: string, record: Record<string, unknown>, key: string, where: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.trim() !== ''))
    fail(name, `${where} needs a "${key}" list of non-empty strings`)
  return value as string[]
}

function child(name: string, record: Record<string, unknown>, key: string, allowed: string[], where: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value))
    fail(name, `${where} needs a "${key}" object`)
  return closed(name, value, allowed, `${where}.${key}`)
}

function parseCommandSource(name: string, record: Record<string, unknown>, where: string): CommandSource {
  const source = child(name, record, 'source', COMMAND_SOURCE_PROPERTIES, where)
  const exit = source.exit
  if (exit !== null && (typeof exit !== 'number' || !Number.isInteger(exit)))
    fail(name, `${where}.source needs an integer "exit" or null`)
  return { command: text(name, source, 'command', `${where}.source`), exit: exit as number | null, effects: textList(name, source, 'effects', `${where}.source`) }
}

function parseLineSource(name: string, record: Record<string, unknown>, where: string): LineSource {
  const source = child(name, record, 'source', LINE_SOURCE_PROPERTIES, where)
  const line = source.line
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1)
    fail(name, `${where}.source needs a "line" of 1 or more`)
  return { path: text(name, source, 'path', `${where}.source`), line }
}

function status(name: string, record: Record<string, unknown>, where: string): ObservedStatus {
  return member(name, text(name, record, 'status', where), OBSERVED_STATUSES, 'status', where)
}

function parseComponent(name: string, entry: Record<string, unknown>, where: string): Component {
  const id = text(name, entry, 'id', where)
  const componentPath = text(name, entry, 'path', where)
  const relations = entry.relations === undefined ? 'found' : member(name, text(name, entry, 'relations', where), OBSERVED_STATUSES, 'relations', where)
  if (relations === 'found') {
    if (entry.reason !== undefined)
      fail(name, `${where} whose relations are "found" carries no "reason"`)
    return { id, path: componentPath, relations }
  }
  return { id, path: componentPath, relations, reason: member(name, text(name, entry, 'reason', where), COMPONENT_REASONS, 'reason', where) }
}

function parseContours(name: string, mechanics: Record<string, unknown>, componentIds: Set<string>): Contour[] {
  const contours = mechanics.contours === undefined
    ? []
    : list(name, mechanics, 'contours').map((entry, index) => {
        const where = `mechanics.contours[${index}]`
        closed(name, entry, CONTOUR_PROPERTIES, where)
        return {
          id: text(name, entry, 'id', where),
          name: text(name, entry, 'name', where),
          kind: member(name, text(name, entry, 'kind', where), CONTOUR_KINDS, 'kind', where),
          declaredBy: text(name, entry, 'declaredBy', where),
          entries: textList(name, entry, 'entries', where).map(file => declared(name, file, componentIds, 'entries', 'component', where)),
        }
      })
  uniqueIds(name, contours.map(contour => contour.id), 'contour')
  return contours
}

function parseInterpretation(name: string, raw: Record<string, unknown>): Interpretation {
  const interpretation = raw.interpretation
  if (!isRecord(interpretation))
    fail(name, 'the document needs an "interpretation" object')
  closed(name, interpretation, INTERPRETATION_PROPERTIES, 'interpretation')
  const claimed = new Set<string>()
  const components = list(name, interpretation, 'components').map((entry, index) => {
    const where = `interpretation.components[${index}]`
    closed(name, entry, INTERPRETED_COMPONENT_PROPERTIES, where)
    const files = textList(name, entry, 'files', where)
    for (const file of files) {
      if (claimed.has(file))
        fail(name, `${where} names "${file}", which an earlier component already holds: a file belongs to one component`)
      claimed.add(file)
    }
    return {
      id: text(name, entry, 'id', where),
      contour: text(name, entry, 'contour', where),
      name: text(name, entry, 'name', where),
      purpose: text(name, entry, 'purpose', where),
      files,
    }
  })
  uniqueIds(name, components.map(component => component.id), 'interpretation component')
  return { authoredBy: member(name, text(name, interpretation, 'authoredBy', 'interpretation'), ENTRY_AUTHORS, 'authoredBy', 'interpretation'), components }
}

function parseMechanics(name: string, raw: Record<string, unknown>): Mechanics {
  const mechanics = child(name, raw, 'mechanics', MECHANICS_PROPERTIES, 'the document')
  const identityEntry = child(name, mechanics, 'identity', IDENTITY_PROPERTIES, 'mechanics')
  const treeEntry = child(name, mechanics, 'tree', TREE_PROPERTIES, 'mechanics')
  const components = list(name, mechanics, 'components').map((entry, index) => {
    const where = `mechanics.components[${index}]`
    closed(name, entry, COMPONENT_PROPERTIES, where)
    return parseComponent(name, entry, where)
  })
  const componentIds = uniqueIds(name, components.map(component => component.id), 'component')
  const contours = parseContours(name, mechanics, componentIds)
  const relations = list(name, mechanics, 'relations').map((entry, index) => {
    const where = `mechanics.relations[${index}]`
    closed(name, entry, RELATION_PROPERTIES, where)
    const relationStatus = status(name, entry, where)
    const to = relationStatus === 'unknown' ? null : declared(name, text(name, entry, 'to', where), componentIds, 'to', 'component', where)
    if (relationStatus === 'unknown' && entry.to !== null)
      fail(name, `${where} of status "unknown" needs "to": null`)
    return {
      from: declared(name, text(name, entry, 'from', where), componentIds, 'from', 'component', where),
      to,
      kind: member(name, text(name, entry, 'kind', where), RELATION_KINDS, 'kind', where),
      specifier: text(name, entry, 'specifier', where),
      status: relationStatus,
      source: parseLineSource(name, entry, where),
    }
  })
  const sha = identityEntry.sha
  if (sha !== null && (typeof sha !== 'string' || sha.trim() === ''))
    fail(name, 'mechanics.identity needs a non-empty "sha" or null')
  const identityStatus = status(name, identityEntry, 'mechanics.identity')
  if ((identityStatus === 'found') !== (sha !== null))
    fail(name, 'mechanics.identity is "found" exactly when it carries a "sha"')
  const treeStatus = status(name, treeEntry, 'mechanics.tree')
  if (treeStatus === 'unknown' && components.length > 0)
    fail(name, 'mechanics.tree of status "unknown" has no components')
  return {
    identity: { sha: sha as string | null, status: identityStatus, source: parseCommandSource(name, identityEntry, 'mechanics.identity') },
    tree: { status: treeStatus, source: parseCommandSource(name, treeEntry, 'mechanics.tree') },
    contours,
    components,
    relations,
  }
}

export function parseModel(source: string, name: string): RepositoryModel {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  }
  catch (error) {
    fail(name, `the document must be JSON: ${(error as Error).message}`)
  }
  if (!isRecord(raw))
    fail(name, 'the document must be an object')
  if (typeof raw.modelVersion === 'number' && raw.modelVersion > MODEL_VERSION)
    throw new RecordAheadOfReader(MODEL_FILE, 'modelVersion', raw.modelVersion, MODEL_VERSION)
  closed(name, raw, MODEL_PROPERTIES, 'the document')
  if (typeof raw.modelVersion !== 'number' || !Number.isInteger(raw.modelVersion) || raw.modelVersion < OLDEST_READABLE_MODEL_VERSION)
    fail(name, `the document needs "modelVersion": ${MODEL_VERSION}`)

  const facts = parseFacts(name, raw)
  const factIds = uniqueIds(name, facts.map(fact => fact.id), 'fact')
  const claims = parseClaims(name, raw, factIds)
  uniqueIds(name, claims.map(claim => claim.id), 'claim')
  const hypotheses = parseHypotheses(name, raw, factIds)
  uniqueIds(name, hypotheses.map(hypothesis => hypothesis.id), 'hypothesis')
  const stages = parseStages(name, raw)
  const stageIds = uniqueIds(name, stages.map(stage => stage.id), 'stage')
  const nodes = parseNodes(name, raw, factIds, stageIds)
  const nodeIds = uniqueIds(name, nodes.map(node => node.id), 'node')
  const links = parseLinks(name, raw, nodeIds)

  const model: RepositoryModel = { modelVersion: MODEL_VERSION, facts, claims, hypotheses, stages, nodes, links }
  if (raw.mechanics !== undefined)
    model.mechanics = parseMechanics(name, raw)
  if (raw.interpretation !== undefined)
    model.interpretation = parseInterpretation(name, raw)
  return model
}
