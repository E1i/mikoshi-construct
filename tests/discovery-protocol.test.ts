import type { Fact, Hypothesis, RepositoryModel } from '../src/model/schema.js'
import type { TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FACT_KINDS, MODEL_FILE, parseModel } from '../src/model/schema.js'
import { buildModel, mergeModel, readModel, writeModel } from '../src/model/write.js'

const PROTOCOL = path.resolve(import.meta.dirname, '../templates/ai/shared/_claude/commands/construct-discover.md')

const VARS: TemplateVars = {
  projectName: 'protocol-fixture',
  scope: '@protocol-fixture',
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

function protocol(): string {
  return readFileSync(PROTOCOL, 'utf8')
}

function jsonBlocks(source: string): string[] {
  return [...source.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1])
}

function factKindsNamed(source: string): string[] {
  const inProse = [...source.matchAll(/`(file-[a-z-]+)`/g)].map(match => match[1])
  const inBlocks = jsonBlocks(source).flatMap(block => [...block.matchAll(/"kind": "([^"]+)"/g)].map(match => match[1]))
  return [...new Set([...inProse, ...inBlocks])].sort()
}

function constructHalf(model: RepositoryModel): string {
  return JSON.stringify({
    modelVersion: model.modelVersion,
    facts: model.facts.filter(fact => fact.authoredBy === 'construct'),
    claims: model.claims.filter(claim => claim.authoredBy === 'construct'),
    hypotheses: model.hypotheses.filter(hypothesis => hypothesis.authoredBy === 'construct'),
  }, null, 2)
}

function discoveryEntry(baseSha: string | null): { fact: Fact, hypothesis: Hypothesis } {
  return {
    fact: { id: 'apps-directory', kind: 'file-exists', path: 'apps/billing/Dockerfile', authoredBy: 'discovery' },
    hypothesis: {
      id: 'service-oriented-structure',
      statement: 'Each directory under apps/ is a deployable service',
      authoredBy: 'discovery',
      baseSha,
      baseClean: true,
      supportedBy: ['apps-directory'],
    },
  }
}

describe('the discovery protocol writes hypotheses the schema accepts', () => {
  it('carries a worked model the parser accepts, with every entry authored by discovery', () => {
    const blocks = jsonBlocks(protocol())
    const models = blocks.filter(block => block.includes('"modelVersion"'))
    expect(models).toHaveLength(1)
    const model = parseModel(models[0], MODEL_FILE)
    const entries = [...model.facts, ...model.claims, ...model.hypotheses]
    expect(entries.length).toBeGreaterThan(1)
    expect(entries.filter(entry => entry.authoredBy !== 'discovery')).toEqual([])
    expect(model.hypotheses.every(hypothesis => hypothesis.supportedBy.length > 0)).toBe(true)
  })

  it('names every fact kind the code declares and no kind it does not', () => {
    expect(factKindsNamed(protocol())).toEqual([...FACT_KINDS].sort())
  })

  it('fails on a kind the code lacks, so the protocol cannot invent a third way of knowing', () => {
    const invented = protocol().replace(/file-contains/g, 'file-matches')
    expect(factKindsNamed(invented)).not.toEqual([...FACT_KINDS].sort())
    expect(factKindsNamed(invented).filter(kind => !(FACT_KINDS as readonly string[]).includes(kind))).toEqual(['file-matches'])
  })
})

describe('a hypothesis discovery wrote survives the next init', () => {
  it('rewrites the construct-authored half byte for byte and carries the discovery half over unchanged', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-protocol-'))
    const input = { vars: VARS, contracts: false, sample: true }
    writeModel(dir, buildModel(input))
    const first = readModel(dir) as RepositoryModel

    const { fact, hypothesis } = discoveryEntry('9f1c0b7e1b3b9f0e2a4c6d8e0a2b4c6d8e0a2b4c')
    writeModel(dir, { ...first, facts: [...first.facts, fact], hypotheses: [hypothesis] })

    writeModel(dir, mergeModel(readModel(dir), buildModel(input)).model)
    const after = readModel(dir) as RepositoryModel

    expect(constructHalf(after)).toBe(constructHalf(first))
    expect(after.hypotheses).toEqual([hypothesis])
    expect(after.facts).toContainEqual(fact)
  })
})
