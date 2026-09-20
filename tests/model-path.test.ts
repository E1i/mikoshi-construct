import type { SelectedPath } from '../src/model/path.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectPath } from '../src/model/path.js'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/model')

interface StopExpectation {
  model: string
  tree: string
  reads: string
  stop: SelectedPath | null
}

const STOPS: Record<string, StopExpectation> = {
  'hypothesis/held': {
    model: 'hypothesis',
    tree: 'hypothesis/held',
    reads: 'every stage of the only claim is held, so the chain is complete',
    stop: null,
  },
  'hypothesis/unsupported': {
    model: 'hypothesis',
    tree: 'hypothesis/unsupported',
    reads: 'enforcement is held and verification lost its supporting file',
    stop: { claimId: 'every-change-passes-the-harness', stage: 'verification', state: 'unsupported' },
  },
  'hypothesis/unevaluable': {
    model: 'hypothesis',
    tree: 'hypothesis/unevaluable',
    reads: 'enforcement names a fact that could not be evaluated',
    stop: { claimId: 'every-change-passes-the-harness', stage: 'enforcement', state: 'unknown' },
  },
  'ambiguous-path': {
    model: 'ambiguous-path',
    tree: 'ambiguous-path/tree',
    reads: 'two chains stop at enforcement and the earlier-declared claim wins',
    stop: { claimId: 'no-secret-reaches-a-commit', stage: 'enforcement', state: 'unsupported' },
  },
  'fresh-init': {
    model: 'fresh-init',
    tree: 'fresh-init',
    reads: 'the directory holds only the model file, so every claim stops at enforcement unsupported',
    stop: { claimId: 'no-committed-secret', stage: 'enforcement', state: 'unsupported' },
  },
}

function read(fixture: string): string {
  return readFileSync(path.join(FIXTURES, fixture, 'construct.model.json'), 'utf8')
}

function stopOf(source: string, tree: string): SelectedPath | null {
  const model = parseModel(source, 'F4')
  return selectPath(model, deriveModelState(model, path.join(FIXTURES, tree)))
}

describe('the path stops at the first stage that is not held', () => {
  for (const [fixture, expectation] of Object.entries(STOPS)) {
    it(`stops where ${expectation.reads} in ${fixture}`, () => {
      expect(stopOf(read(expectation.model), expectation.tree)).toEqual(expectation.stop)
    })
  }

  it('never reports a stage that is held', () => {
    for (const expectation of Object.values(STOPS))
      expect(stopOf(read(expectation.model), expectation.tree)?.state).not.toBe('held')
  })

  it('breaks a tie on declaration order, not on id or statement text', () => {
    const source = read('ambiguous-path')
    const raw = JSON.parse(source) as { claims: unknown[] }
    const [first, second, ...rest] = raw.claims
    const reordered = JSON.stringify({ ...raw, claims: [second, first, ...rest] })

    expect(stopOf(source, 'ambiguous-path/tree')?.claimId).toBe('no-secret-reaches-a-commit')
    expect(stopOf(reordered, 'ambiguous-path/tree')).toEqual({
      claimId: 'imports-respect-the-dependency-policy',
      stage: 'enforcement',
      state: 'unsupported',
    })
  })

  it('prefers the chain stopping at the earlier stage over one declared before it but deeper', () => {
    const raw = JSON.parse(read('ambiguous-path')) as { claims: { id: string, verification: { supportedBy: string[] } }[] }
    const harness = raw.claims.find(claim => claim.id === 'every-change-passes-the-harness')!
    harness.verification.supportedBy = ['commit-hook']
    const deeperFirst = JSON.stringify({ ...raw, claims: [harness, ...raw.claims.filter(claim => claim !== harness)] })

    expect(stopOf(deeperFirst, 'ambiguous-path/tree')).toEqual({
      claimId: 'no-secret-reaches-a-commit',
      stage: 'enforcement',
      state: 'unsupported',
    })
  })
})
