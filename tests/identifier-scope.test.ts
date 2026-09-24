import type { DoctorResult } from '../src/commands/doctor/index.js'
import type { TemplateVars } from '../src/presets/index.js'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCTOR_FIELD_FAMILY, doctorJson, projectKnowledge, RETIRED_IDENTIFIERS } from '../src/commands/doctor/index.js'
import { LEVELS } from '../src/commands/doctor/verdict.js'
import { ENFORCEMENT_LEVELS } from '../src/model/schema.js'
import { buildModel } from '../src/model/write.js'

const VARS: TemplateVars = {
  projectName: 'scope-fixture',
  scope: '@scope-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.1.0',
}

describe('an identifier others cite carries one scope, and only one', () => {
  it('reads the enforcement levels from one list rather than two kept in step, so there is no second copy to widen', () => {
    expect(LEVELS).toBe(ENFORCEMENT_LEVELS)
  })

  it('gives every check id exactly one home, so no id can come to mean two things', () => {
    const claims = buildModel({ vars: VARS, contracts: true, sample: true }).claims
    const checkIds = claims.flatMap(claim => claim.checkId ?? [])
    expect(checkIds.length).toBeGreaterThan(0)
    expect(new Set(checkIds).size).toBe(checkIds.length)
    expect(checkIds.filter(id => claims.some(claim => claim.id === id && claim.checkId !== id))).toEqual([])
  })
})

const ROOT = path.resolve(import.meta.dirname, '..')

type IdentifierKind = 'field' | 'envelope' | 'claim' | 'check' | 'fact' | 'hypothesis'

interface NamedIdentifier {
  name: string
  kinds: IdentifierKind[]
}

const IDENTIFIER_TABLES: { header: string[], columns: [number, IdentifierKind][] }[] = [
  { header: ['Field', 'Family'], columns: [[0, 'field']] },
  { header: ['`id`', 'The claim it renders', 'When it appears'], columns: [[0, 'check'], [1, 'claim']] },
]

const ENVELOPE_KEYS = Object.keys(doctorJson({} as DoctorResult))

function currentIdentifiers(): Record<IdentifierKind, string[]> {
  const model = buildModel({ vars: VARS, contracts: true, sample: true })
  return {
    field: Object.keys(DOCTOR_FIELD_FAMILY),
    envelope: ENVELOPE_KEYS,
    claim: model.claims.map(claim => claim.id),
    check: projectKnowledge(model, ROOT).checks.map(check => check.id),
    fact: model.facts.map(fact => fact.id),
    hypothesis: model.hypotheses.map(hypothesis => hypothesis.id),
  }
}

function everyCurrentIdentifier(): string[] {
  return Object.values(currentIdentifiers()).flat()
}

type KindByKey = Record<string, IdentifierKind>

const DOCTOR_RESULT_KEYS: KindByKey = { id: 'check', claimId: 'claim' }

function namedIdentifiers(value: unknown, kindByKey: KindByKey): NamedIdentifier[] {
  if (Array.isArray(value))
    return value.flatMap(entry => namedIdentifiers(entry, kindByKey))
  if (typeof value !== 'object' || value == null)
    return []
  return Object.entries(value).flatMap(([key, entry]) =>
    Object.hasOwn(kindByKey, key) && typeof entry === 'string' ? [{ name: entry, kinds: [kindByKey[key]] }] : namedIdentifiers(entry, kindByKey))
}

const BLOCK_KINDS = ['doctor-result', 'repository-model', 'manifest', 'sync-report'] as const
type BlockKind = (typeof BLOCK_KINDS)[number]

const SCANNED_KINDS: BlockKind[] = ['doctor-result', 'repository-model']

function kindOf(block: Record<string, unknown>): BlockKind | null {
  if (Array.isArray(block.checks))
    return 'doctor-result'
  if (Array.isArray(block.claims) && Array.isArray(block.facts))
    return 'repository-model'
  if (typeof block.manifestVersion === 'number')
    return 'manifest'
  if (typeof block.fromVersion === 'string' && typeof block.toVersion === 'string')
    return 'sync-report'
  return null
}

function jsonBlocks(source: string): Record<string, unknown>[] {
  return [...source.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1]) as unknown
      return typeof parsed === 'object' && parsed != null && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : []
    }
    catch {
      return []
    }
  })
}

function unclassifiedBlocks(source: string): string[] {
  return jsonBlocks(source).flatMap(block => (kindOf(block) == null ? [Object.keys(block).slice(0, 3).join(', ')] : []))
}

function scannedBlocks(source: string): Record<string, unknown>[] {
  return jsonBlocks(source).filter((block) => {
    const kind = kindOf(block)
    return kind != null && SCANNED_KINDS.includes(kind)
  })
}

function tableRows(source: string): string[][][] {
  const tables: string[][][] = []
  let table: string[][] = []
  for (const line of `${source}\n`.split('\n')) {
    const row = line.trim()
    if (row.startsWith('|') && row.endsWith('|')) {
      table.push(row.split('|').slice(1, -1).map(cell => cell.trim()))
      continue
    }
    if (table.length > 0)
      tables.push(table)
    table = []
  }
  return tables
}

function tableIdentifiers(source: string): NamedIdentifier[] {
  return tableRows(source).flatMap((table) => {
    const scanned = IDENTIFIER_TABLES.find(candidate => candidate.header.join('|') === table[0].join('|'))
    if (scanned == null)
      return []
    return table.slice(2).flatMap(row => scanned.columns.flatMap(([column, kind]) => {
      const token = /^`([^`]+)`$/.exec(row[column] ?? '')
      return token == null ? [] : [{ name: token[1], kinds: [kind] }]
    }))
  })
}

const MODEL_ENTRY_KINDS: Record<string, IdentifierKind> = { facts: 'fact', claims: 'claim', hypotheses: 'hypothesis' }

function modelIdentifiers(block: Record<string, unknown>): NamedIdentifier[] {
  return Object.entries(MODEL_ENTRY_KINDS).flatMap(([key, kind]) => {
    const entries = block[key]
    const theCodeMustOwn = Array.isArray(entries)
      ? entries.filter(entry => typeof entry === 'object' && entry != null && (entry as Record<string, unknown>).authoredBy !== 'discovery')
      : []
    return namedIdentifiers(theCodeMustOwn, { id: kind, claimId: 'claim', checkId: 'check' })
  })
}

function doctorResultIdentifiers(block: Record<string, unknown>): NamedIdentifier[] {
  const keys = Object.keys(block).map(name => ({ name, kinds: ['field', 'envelope'] as IdentifierKind[] }))
  return [...keys, ...namedIdentifiers(block, DOCTOR_RESULT_KEYS)]
}

function identifiersNamed(source: string): NamedIdentifier[] {
  const named = scannedBlocks(source).flatMap(block =>
    (kindOf(block) === 'repository-model' ? modelIdentifiers(block) : doctorResultIdentifiers(block)))
  return [...named, ...tableIdentifiers(source)]
}

function namesOf(named: NamedIdentifier[]): string[] {
  return named.map(identifier => identifier.name)
}

function reused(current: string[], retired: readonly string[]): string[] {
  return current.filter(name => retired.includes(name))
}

function unowned(named: NamedIdentifier[]): string[] {
  const current = currentIdentifiers()
  const retired = new Set<string>(RETIRED_IDENTIFIERS)
  const owned = (identifier: NamedIdentifier): boolean =>
    retired.has(identifier.name) || identifier.kinds.some(kind => current[kind].includes(identifier.name))
  return [...new Set(named.filter(identifier => !owned(identifier)).map(identifier => identifier.name))].sort()
}

function scannedFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name.startsWith('.') ? [] : scannedFiles(full)
    return entry.isFile() ? [full] : []
  })
}

function scanned(): { file: string, source: string }[] {
  const files = [
    ...scannedFiles(path.join(ROOT, 'docs')).filter(file => file.endsWith('.md')),
    ...scannedFiles(path.join(ROOT, 'templates')),
  ]
  return files.map(file => ({ file: path.relative(ROOT, file), source: readFileSync(file, 'utf8') }))
}

const DOCTOR_RESULT_BLOCK = '```json\n{ "ok": true, "checks": [{ "id": "ci", "claimId": "every-change-passes-the-harness" }] }\n```\n'

const MODEL_BLOCK = '```json\n{ "modelVersion": 1, "facts": [], "claims": [{ "id": "no-committed-secret", "authoredBy": "construct", "checkId": "ci" }], "hypotheses": [] }\n```\n'

const FIELD_TABLE = '| Field | Family |\n|---|---|\n| `weakestLink` | knowledge |\n'

const CHECK_TABLE = '| `id` | The claim it renders | When it appears |\n|---|---|---|\n| `ci` | `every-change-passes-the-harness` | Always |\n'

describe('an identifier the documentation names is one the code owns or has retired', () => {
  it('finds every identifier the docs and templates name in the current list or the retired one', () => {
    for (const { file, source } of scanned())
      expect(unowned(identifiersNamed(source)), file).toEqual([])
  })

  it('scans the blocks and tables it means to scan, so a reworded heading fails rather than quietly narrowing the scan', () => {
    const rows = scanned().flatMap(({ source }) => tableRows(source))
    for (const table of IDENTIFIER_TABLES)
      expect(rows.map(found => found[0].join('|')), table.header.join('|')).toContain(table.header.join('|'))
    const names = scanned().flatMap(({ source }) => namesOf(identifiersNamed(source)))
    expect(names).toContain('youAreHere')
    expect(names).toContain('ci')
    expect(names).toContain('every-change-passes-the-harness')
  })

  it('names an identifier belonging to neither list', () => {
    expect(unowned(identifiersNamed(DOCTOR_RESULT_BLOCK.replace('"ci"', '"soulkill"')))).toEqual(['soulkill'])
    expect(unowned(identifiersNamed(FIELD_TABLE.replace('weakestLink', 'wakeUp')))).toEqual(['wakeUp'])
  })

  it('names an identifier standing in the place of another kind, so a field name offered as a check id fails', () => {
    expect(unowned(identifiersNamed(DOCTOR_RESULT_BLOCK.replace('"ci"', '"schemaVersion"')))).toEqual(['schemaVersion'])
    expect(unowned(identifiersNamed(DOCTOR_RESULT_BLOCK.replace('"ci"', '"youAreHere"')))).toEqual(['youAreHere'])
    expect(unowned(identifiersNamed(DOCTOR_RESULT_BLOCK.replace('"every-change-passes-the-harness"', '"ci"')))).toEqual(['ci'])
    expect(unowned(identifiersNamed(FIELD_TABLE.replace('weakestLink', 'ci')))).toEqual(['ci'])
    expect(unowned(identifiersNamed(FIELD_TABLE.replace('weakestLink', 'schemaVersion')))).toEqual(['schemaVersion'])
    expect(unowned(identifiersNamed(CHECK_TABLE.replace('`every-change-passes-the-harness`', '`ci`')))).toEqual(['ci'])
    expect(unowned(identifiersNamed(CHECK_TABLE.replace('| `ci` |', '| `youAreHere` |')))).toEqual(['youAreHere'])
    expect(unowned(identifiersNamed(MODEL_BLOCK.replace('"no-committed-secret"', '"youAreHere"')))).toEqual(['youAreHere'])
    expect(unowned(identifiersNamed(MODEL_BLOCK.replace('"checkId": "ci"', '"checkId": "youAreHere"')))).toEqual(['youAreHere'])
  })

  it('accepts each identifier in the place of its own kind', () => {
    expect(unowned(identifiersNamed(DOCTOR_RESULT_BLOCK))).toEqual([])
    expect(unowned(identifiersNamed(DOCTOR_RESULT_BLOCK.replace('"ci"', '"no-committed-secret"')))).toEqual([])
    expect(unowned(identifiersNamed(CHECK_TABLE))).toEqual([])
    expect(unowned(identifiersNamed(MODEL_BLOCK))).toEqual([])
  })

  it('lets the documentation describe a removal, since a retired name is one the code still owns', () => {
    expect(unowned(identifiersNamed(DOCTOR_RESULT_BLOCK.replace('"ci"', '"hook"')))).toEqual([])
    expect(unowned(identifiersNamed(FIELD_TABLE))).toEqual([])
  })

  it('reads a token in code formatting and not a word in prose, so an English word is never an identifier', () => {
    const prose = 'A local hook, bypassable with `--no-verify`, is not what `pnpm run quality` runs.\n\n| Option | Default |\n|---|---|\n| `--json` | `false` |\n'
    expect(unowned(identifiersNamed(prose))).toEqual([])
  })

  it('reads only the blocks whose keys are doctor\'s own, leaving the manifest and the sync report to their vocabularies', () => {
    const manifest = '```json\n{ "manifestVersion": 4, "construct": "0.5.1", "files": {} }\n```\n'
    const report = '```json\n{ "fromVersion": "0.1.1", "toVersion": "0.5.1", "counts": {}, "paths": [] }\n```\n'
    expect(namesOf(identifiersNamed(manifest))).toEqual([])
    expect(namesOf(identifiersNamed(report))).toEqual([])
    expect(namesOf(identifiersNamed(DOCTOR_RESULT_BLOCK)).length).toBeGreaterThan(0)
  })

  it('classifies every json block it meets, so one of a shape nobody decided about fails instead of not joining the scan', () => {
    for (const { file, source } of scanned())
      expect(unclassifiedBlocks(source), file).toEqual([])
    const kinds = scanned().flatMap(({ source }) => jsonBlocks(source).flatMap(block => kindOf(block) ?? []))
    expect(kinds.filter(kind => !BLOCK_KINDS.includes(kind))).toEqual([])
    expect(SCANNED_KINDS.filter(kind => !BLOCK_KINDS.includes(kind))).toEqual([])
    expect(new Set(kinds).size).toBeGreaterThan(1)
  })

  it('names a block of an unrecognised shape rather than passing over it, which is what selection could never do', () => {
    const invented = '```json\n{ "ledgerVersion": 2, "runs": [] }\n```\n'
    expect(unclassifiedBlocks(invented)).toEqual(['ledgerVersion, runs'])
    expect(unclassifiedBlocks(DOCTOR_RESULT_BLOCK)).toEqual([])
  })

  it('scans a model block for the claim ids it names and not for the keys that hold them', () => {
    expect(unclassifiedBlocks(MODEL_BLOCK)).toEqual([])
    expect(namesOf(identifiersNamed(MODEL_BLOCK))).toContain('no-committed-secret')
    expect(namesOf(identifiersNamed(MODEL_BLOCK))).not.toContain('modelVersion')
    expect(unowned(identifiersNamed(MODEL_BLOCK.replace('"no-committed-secret"', '"no-such-claim"')))).toEqual(['no-such-claim'])
  })

  it('requires an id the construct authored to be one the code owns, and leaves an id discovery authored to discovery', () => {
    const invented = MODEL_BLOCK.replace('"no-committed-secret"', '"no-such-claim"')
    expect(unowned(identifiersNamed(invented))).toEqual(['no-such-claim'])
    expect(unowned(identifiersNamed(invented.replace('"authoredBy": "construct"', '"authoredBy": "discovery"')))).toEqual([])
    expect(namesOf(identifiersNamed(invented.replace('"authoredBy": "construct"', '"authoredBy": "discovery"')))).not.toContain('no-such-claim')
    expect(unowned(identifiersNamed(invented.replace('"authoredBy": "construct", ', '')))).toEqual(['no-such-claim'])
    expect(namesOf(identifiersNamed(MODEL_BLOCK))).toContain('no-committed-secret')
  })

  it('keeps a retired name out of the current list, so no identifier can come back meaning something else', () => {
    expect(reused(everyCurrentIdentifier(), RETIRED_IDENTIFIERS)).toEqual([])
    expect(reused([...everyCurrentIdentifier(), 'hook'], RETIRED_IDENTIFIERS)).toEqual(['hook'])
  })
})
