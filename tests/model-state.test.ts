import type { FactEvaluation, StageFinding } from '../src/model/state.js'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState, resolveFinding } from '../src/model/state.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/model/hypothesis')
const MODEL_FILE = path.join(FIXTURES, 'construct.model.json')

const HYPOTHESIS = 'workspace-with-one-deployable'
const UNNAMED_HYPOTHESIS = 'nothing-is-named-under-this-one'
const CLAIM = 'every-change-passes-the-harness'

interface TreeExpectation {
  reads: string
  hypothesis: StageFinding
  enforcement: StageFinding
  verification: StageFinding
  facts: Record<string, FactEvaluation>
}

const TREES: Record<string, TreeExpectation> = {
  held: {
    reads: 'every named fact was evaluated and holds',
    hypothesis: { state: 'held' },
    enforcement: { state: 'held' },
    verification: { state: 'held' },
    facts: { 'api-app': 'holds', 'api-app-runs-the-harness': 'holds', 'ci-runs-the-harness': 'holds' },
  },
  unsupported: {
    reads: 'the same model against a tree missing one supporting file',
    hypothesis: { state: 'unsupported', doesNotHold: ['apps/api/package.json'] },
    enforcement: { state: 'held' },
    verification: { state: 'unsupported', doesNotHold: ['apps/api/package.json'] },
    facts: { 'api-app': 'does-not-hold', 'api-app-runs-the-harness': 'does-not-hold', 'ci-runs-the-harness': 'holds' },
  },
  unevaluable: {
    reads: 'the same model where a file-contains fact points at a directory',
    hypothesis: { state: 'unknown', reason: 'unevaluable', unevaluable: ['.github/workflows/ci.yml'] },
    enforcement: { state: 'unknown', reason: 'unevaluable', unevaluable: ['.github/workflows/ci.yml'] },
    verification: { state: 'held' },
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

      expect(derived.hypotheses[HYPOTHESIS]).toEqual(expectation.hypothesis)
      expect(derived.claims[CLAIM]).toEqual({ enforcement: expectation.enforcement, verification: expectation.verification })
      for (const [id, evaluation] of Object.entries(expectation.facts))
        expect(derived.facts[id], `${tree}: ${id}`).toBe(evaluation)
    })
  }

  it('does not restate an unsupported hypothesis as standing', () => {
    const derived = deriveModelState(model(), path.join(FIXTURES, 'unsupported'))
    expect(Object.values(derived.hypotheses).map(finding => finding.state)).not.toContain('held')
  })

  it('reaches unsupported only when every named fact was evaluated', () => {
    const evaluations: Record<string, FactEvaluation> = { a: 'holds', b: 'does-not-hold', c: 'unevaluable' }
    expect(resolveFinding([], [], evaluations).state).toBe('unknown')
    expect(resolveFinding([], ['a'], evaluations).state).toBe('held')
    expect(resolveFinding([], ['a', 'b'], evaluations).state).toBe('unsupported')
    expect(resolveFinding([], ['b', 'c'], evaluations).state).toBe('unknown')
    expect(resolveFinding([], ['missing'], evaluations).state).toBe('unknown')
  })

  it('names the facts behind a stage that is not held, and blames nobody for one it could not evaluate', () => {
    const evaluations: Record<string, FactEvaluation> = { a: 'holds', b: 'does-not-hold', c: 'unevaluable' }
    const facts = [
      { id: 'a', kind: 'file-exists', path: 'a.md', authoredBy: 'construct' },
      { id: 'b', kind: 'file-exists', path: 'b.md', authoredBy: 'construct' },
      { id: 'c', kind: 'file-exists', path: 'c.md', authoredBy: 'construct' },
    ] as const

    expect(resolveFinding(facts, [], evaluations)).toEqual({ state: 'unknown', reason: 'no-fact-named' })
    expect(resolveFinding(facts, ['a'], evaluations)).toEqual({ state: 'held' })
    expect(resolveFinding(facts, ['a', 'b'], evaluations)).toEqual({ state: 'unsupported', doesNotHold: ['b.md'] })
    expect(resolveFinding(facts, ['b', 'c'], evaluations)).toEqual({ state: 'unknown', reason: 'unevaluable', unevaluable: ['c.md'] })
  })

  it('leaves a hypothesis with no facts named under it unknown in every tree', () => {
    for (const tree of Object.keys(TREES))
      expect(deriveModelState(model(), path.join(FIXTURES, tree)).hypotheses[UNNAMED_HYPOTHESIS]).toEqual({ state: 'unknown', reason: 'no-fact-named' })
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

describe('which fact a stage names first, when more than one stopped matching', () => {
  const FACTS = [
    { id: 'first-declared', kind: 'file-exists' as const, path: 'alpha.yml', authoredBy: 'construct' as const },
    { id: 'second-declared', kind: 'file-exists' as const, path: 'beta.yml', authoredBy: 'construct' as const },
  ]
  const NEITHER_HOLDS: Record<string, FactEvaluation> = { 'first-declared': 'does-not-hold', 'second-declared': 'does-not-hold' }

  function doesNotHold(supportedBy: string[]): string[] {
    const finding = resolveFinding(FACTS, supportedBy, NEITHER_HOLDS)
    return finding.state === 'unsupported' ? finding.doesNotHold : []
  }

  it('follows the order the stage declares them in, which is the key selectPath already breaks ties by', () => {
    expect(doesNotHold(['first-declared', 'second-declared'])).toEqual(['alpha.yml', 'beta.yml'])
  })

  it('names the other one when the same two are declared the other way round, so the choice is the declared key and not the order they were walked in', () => {
    expect(doesNotHold(['second-declared', 'first-declared'])).toEqual(['beta.yml', 'alpha.yml'])
  })
})
