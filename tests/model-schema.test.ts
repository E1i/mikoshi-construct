import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseModel } from '../src/model/schema.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/model')

const REJECTED: Record<string, string> = {
  'hypothesis-confidence.json': 'unexpected property "confidence"',
  'hypothesis-strength.json': 'unexpected property "strength"',
  'hypothesis-score.json': 'unexpected property "score"',
  'hypothesis-support.json': 'unexpected property "support"',
  'state-on-a-hypothesis.json': 'hypotheses[0] carries an unexpected property "state"',
  'state-inside-enforcement.json': 'claims[0].enforcement carries an unexpected property "state"',
  'unknown-top-level-key.json': 'the document carries an unexpected property "notes"',
  'file-hashes.json': 'the document carries an unexpected property "files"',
  'enforcement-without-supported-by.json': 'claims[0].enforcement needs a "supportedBy" list of fact ids',
}

function fixture(file: string): string {
  return readFileSync(path.join(FIXTURES, file), 'utf8')
}

describe('the repository model schema', () => {
  it('accepts a repository just materialized, with claims held up by facts and no hypotheses yet', () => {
    const model = parseModel(fixture('fresh-init/construct.model.json'), 'F1')
    const factIds = new Set(model.facts.map(fact => fact.id))

    expect(model.claims.length).toBeGreaterThan(0)
    for (const claim of model.claims) {
      expect(claim.enforcement?.supportedBy.length, `${claim.id} names the facts its enforcement stands on`).toBeGreaterThan(0)
      expect(claim.verification?.supportedBy.length, `${claim.id} names the facts its verification stands on`).toBeGreaterThan(0)
      for (const id of [...claim.enforcement?.supportedBy ?? [], ...claim.verification?.supportedBy ?? []])
        expect(factIds).toContain(id)
    }
    expect(model.hypotheses, 'discovery has never run in a fresh materialization').toEqual([])
    expect(fixture('fresh-init/construct.model.json')).not.toContain('"state"')
  })

  it('names every rejection fixture in the table', () => {
    const files = readdirSync(path.join(FIXTURES, 'rejected')).sort()
    expect(files).toEqual(Object.keys(REJECTED).sort())
  })

  for (const [file, fragment] of Object.entries(REJECTED)) {
    it(`rejects ${file.replace(/\.json$/, '').replace(/-/g, ' ')}`, () => {
      expect(() => parseModel(fixture(`rejected/${file}`), file)).toThrow(fragment)
    })
  }

  it('requires a needle exactly where the fact kind reads one', () => {
    const model = (facts: unknown): string => JSON.stringify({ modelVersion: 1, facts, claims: [], hypotheses: [] })
    expect(() => parseModel(model([{ id: 'a', kind: 'file-contains', path: 'ci.yml' }]), 'M')).toThrow('facts[0] of kind "file-contains" needs a non-empty "needle"')
    expect(() => parseModel(model([{ id: 'a', kind: 'file-exists', path: 'ci.yml', needle: 'x' }]), 'M')).toThrow('facts[0] of kind "file-exists" must not carry a "needle"')
  })

  it('requires every supportedBy entry to name a fact that exists, and every id to be unique', () => {
    const fact = { id: 'a', kind: 'file-exists', path: 'ci.yml' }
    const hypothesis = { id: 'h', statement: 'a guess', authoredBy: 'discovery', baseSha: null, supportedBy: ['missing'] }
    expect(() => parseModel(JSON.stringify({ modelVersion: 1, facts: [fact], claims: [], hypotheses: [hypothesis] }), 'M')).toThrow('hypotheses[0] supportedBy refers to unknown fact "missing"')
    expect(() => parseModel(JSON.stringify({ modelVersion: 1, facts: [fact, fact], claims: [], hypotheses: [] }), 'M')).toThrow('fact ids must be unique')
  })
})
