import type { FactEvaluation, ModelState } from '../src/model/state.js'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState, resolveState } from '../src/model/state.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/model/hypothesis')
const MODEL_FILE = path.join(FIXTURES, 'construct.model.json')

const HYPOTHESIS = 'workspace-with-one-deployable'
const UNNAMED_HYPOTHESIS = 'nothing-is-named-under-this-one'
const CLAIM = 'every-change-passes-the-harness'

interface TreeExpectation {
  reads: string
  hypothesis: ModelState
  enforcement: ModelState
  verification: ModelState
  facts: Record<string, FactEvaluation>
}

const TREES: Record<string, TreeExpectation> = {
  held: {
    reads: 'every named fact was evaluated and holds',
    hypothesis: 'held',
    enforcement: 'held',
    verification: 'held',
    facts: { 'api-app': 'holds', 'api-app-runs-the-harness': 'holds', 'ci-runs-the-harness': 'holds' },
  },
  unsupported: {
    reads: 'the same model against a tree missing one supporting file',
    hypothesis: 'unsupported',
    enforcement: 'held',
    verification: 'unsupported',
    facts: { 'api-app': 'does-not-hold', 'api-app-runs-the-harness': 'does-not-hold', 'ci-runs-the-harness': 'holds' },
  },
  unevaluable: {
    reads: 'the same model where a file-contains fact points at a directory',
    hypothesis: 'unknown',
    enforcement: 'unknown',
    verification: 'held',
    facts: { 'api-app': 'holds', 'api-app-runs-the-harness': 'holds', 'ci-runs-the-harness': 'unevaluable' },
  },
}

function model(): ReturnType<typeof parseModel> {
  return parseModel(readFileSync(MODEL_FILE, 'utf8'), 'F2')
}

function snapshot(): Record<string, string> {
  return Object.fromEntries(readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name)
      return [path.relative(FIXTURES, file), readFileSync(file, 'base64')]
    }))
}

describe('state is derived from the tree on every read', () => {
  for (const [tree, expectation] of Object.entries(TREES)) {
    it(`derives ${tree} where ${expectation.reads}`, () => {
      const derived = deriveModelState(model(), path.join(FIXTURES, tree))

      expect(derived.hypotheses[HYPOTHESIS]).toBe(expectation.hypothesis)
      expect(derived.claims[CLAIM]).toEqual({ enforcement: expectation.enforcement, verification: expectation.verification })
      for (const [id, evaluation] of Object.entries(expectation.facts))
        expect(derived.facts[id], `${tree}: ${id}`).toBe(evaluation)
    })
  }

  it('does not restate an unsupported hypothesis as standing', () => {
    const derived = deriveModelState(model(), path.join(FIXTURES, 'unsupported'))
    expect(Object.values(derived.hypotheses)).not.toContain('held')
  })

  it('reaches unsupported only when every named fact was evaluated', () => {
    const evaluations: Record<string, FactEvaluation> = { a: 'holds', b: 'does-not-hold', c: 'unevaluable' }
    expect(resolveState([], evaluations)).toBe('unknown')
    expect(resolveState(['a'], evaluations)).toBe('held')
    expect(resolveState(['a', 'b'], evaluations)).toBe('unsupported')
    expect(resolveState(['b', 'c'], evaluations)).toBe('unknown')
    expect(resolveState(['missing'], evaluations)).toBe('unknown')
  })

  it('leaves a hypothesis with no facts named under it unknown in every tree', () => {
    for (const tree of Object.keys(TREES))
      expect(deriveModelState(model(), path.join(FIXTURES, tree)).hypotheses[UNNAMED_HYPOTHESIS]).toBe('unknown')
  })

  it('writes nothing: two derivations agree and the fixtures stay byte-identical', () => {
    const before = snapshot()
    const first = deriveModelState(model(), path.join(FIXTURES, 'held'))
    const second = deriveModelState(model(), path.join(FIXTURES, 'held'))

    expect(second).toEqual(first)
    expect(snapshot()).toEqual(before)
    expect(readFileSync(MODEL_FILE, 'utf8')).not.toContain('"state"')
  })
})
