import { RecordAheadOfReader } from '../record-ahead.js'

export const MODEL_FILE = 'construct.model.json'
export const MODEL_VERSION = 4
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

export interface RepositoryModel {
  modelVersion: number
  facts: Fact[]
  claims: Claim[]
  hypotheses: Hypothesis[]
  stages: Stage[]
  nodes: AbilityNode[]
  links: Link[]
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
const OPTIONAL_LISTS = ['stages', 'nodes', 'links']
const MODEL_PROPERTIES = ['modelVersion', 'facts', 'claims', 'hypotheses', 'stages', 'nodes', 'links']

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

  return { modelVersion: MODEL_VERSION, facts, claims, hypotheses, stages, nodes, links }
}
