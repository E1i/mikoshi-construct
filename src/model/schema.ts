import { RecordAheadOfReader } from '../record-ahead.js'

export const MODEL_FILE = 'construct.model.json'
export const MODEL_VERSION = 2
const OLDEST_READABLE_MODEL_VERSION = 1

export const FACT_KINDS = ['file-exists', 'file-contains', 'file-lacks', 'report-covers', 'report-misses'] as const
export type FactKind = (typeof FACT_KINDS)[number]

const NEEDLE_KINDS: readonly FactKind[] = ['file-contains', 'file-lacks']
export const REPORT_KINDS: readonly FactKind[] = ['report-covers', 'report-misses']

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

export interface RepositoryModel {
  modelVersion: number
  facts: Fact[]
  claims: Claim[]
  hypotheses: Hypothesis[]
}

const FACT_PROPERTIES = ['id', 'kind', 'path', 'authoredBy', 'needle', 'surface']
const ENFORCEMENT_PROPERTIES = ['mechanism', 'level', 'supportedBy']
const VERIFICATION_PROPERTIES = ['mechanism', 'supportedBy']
const CLAIM_PROPERTIES = ['id', 'statement', 'authoredBy', 'enforcement', 'verification', 'checkId']
export const HYPOTHESIS_PROPERTIES = ['id', 'statement', 'authoredBy', 'baseSha', 'evidenceClean', 'supportedBy']
const MODEL_PROPERTIES = ['modelVersion', 'facts', 'claims', 'hypotheses']

export class DanglingFactReference extends Error {
  readonly factId: string
  readonly entry: string

  constructor(name: string, entry: string, factId: string) {
    super(`${name}: ${entry} supportedBy refers to unknown fact "${factId}"`)
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
  const value = record[key]
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
      throw new DanglingFactReference(name, where, id)
  }
  return ids
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
    if (REPORT_KINDS.includes(kind))
      fact.surface = globs(name, entry, `${where} of kind "${kind}"`)
    else if (entry.surface !== undefined)
      fail(name, `${where} of kind "${kind}" must not carry a "surface"`)
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

  return { modelVersion: MODEL_VERSION, facts, claims, hypotheses }
}
