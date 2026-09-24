import type { DoctorResult, HypothesisReading } from '../src/commands/doctor/index.js'
import type { RepositoryModel } from '../src/model/schema.js'
import type { StageFinding } from '../src/model/state.js'
import type { Lore } from '../src/ui/lore.js'
import type { ThemeName } from '../src/ui/theme.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { printDoctor, projectKnowledge } from '../src/commands/doctor/index.js'
import { parseModel } from '../src/model/schema.js'
import { createUi } from '../src/ui/console.js'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { READS_AS_A_VERDICT } from './lore-vocabulary.js'

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/model/hypotheses-reported')
const TREE = path.join(FIXTURE, 'tree')
const EMOJI = /\p{Extended_Pictographic}/u
const LORE_VOCABULARY = ['GLITCH', 'FLATLINED', 'CONSTRUCT STABLE', 'ENFORCEMENT TRACE', 'YOU ARE HERE', 'STANDING HYPOTHESES', 'READS ']

function model(): RepositoryModel {
  return parseModel(readFileSync(path.join(FIXTURE, 'construct.model.json'), 'utf8'), 'hypotheses-reported')
}

function readings(): HypothesisReading[] {
  return projectKnowledge(model(), TREE).hypotheses
}

function result(overrides: Partial<DoctorResult> = {}): DoctorResult {
  const knowledge = projectKnowledge(model(), TREE)
  return {
    ok: true,
    missingFiles: [],
    modifiedFiles: [],
    unreadableFiles: [],
    missingDiscovery: [],
    provenance: [],
    harness: { command: 'pnpm run quality', state: 'checked' },
    harnessProblems: [],
    uncollectedTests: [],
    warnings: [],
    checks: knowledge.checks,
    hypotheses: knowledge.hypotheses,
    youAreHere: knowledge.youAreHere,
    notCarried: [],
    versionGap: { materializedBy: '0.1.0', readBy: '0.1.0', pending: 0 },
    ...overrides,
  }
}

function render(value: DoctorResult, theme: ThemeName = 'plain'): string {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: theme === 'plain', johnny: theme === 'johnny' }), text => lines.push(text))
  printDoctor(ui, value)
  // eslint-disable-next-line no-control-regex
  return lines.join('').replaceAll(/\u001B\[[\d;]*m/g, '')
}

const FACT_PATHS = model().facts.map(fact => fact.path)

function pathsCarriedBy(finding: StageFinding): string[] {
  if (finding.state === 'unsupported')
    return finding.doesNotHold
  if (finding.state === 'unknown' && finding.reason === 'unevaluable')
    return finding.unevaluable
  return []
}

function pathsNamedIn(line: string): string[] {
  return FACT_PATHS.filter(factPath => line.includes(factPath))
}

function lineFor(output: string, hypothesisId: string): string {
  return output.split('\n').find(line => line.trim().startsWith(hypothesisId)) ?? ''
}

interface HypothesisExpectation {
  finding: StageFinding
  says: string[]
  omits: string[]
}

const HYPOTHESES: Record<string, HypothesisExpectation> = {
  'a-pnpm-workspace': {
    finding: { state: 'held' },
    says: ['held', 'This repository is a pnpm workspace', 'uncommitted changes'],
    omits: ['no longer matching', 'could not be read'],
  },
  'one-deployable-under-apps': {
    finding: { state: 'unsupported', doesNotHold: ['apps/api/package.json'] },
    says: ['unsupported', 'The single deployable is apps/api', 'no longer matching', 'apps/api/package.json'],
    omits: ['could not be read', 'uncommitted changes'],
  },
  'ci-runs-the-harness-on-every-change': {
    finding: { state: 'unknown', reason: 'unevaluable', unevaluable: ['.github/workflows/ci.yml'] },
    says: ['unknown', 'could not be read here', '.github/workflows/ci.yml'],
    omits: ['no fact is named', 'no longer matching'],
  },
  'deployed-as-a-single-container': {
    finding: { state: 'unknown', reason: 'no-fact-named' },
    says: ['unknown', 'no fact is named under it, so nothing was read'],
    omits: ['could not be read', 'no longer matching'],
  },
}

describe('doctor reads each hypothesis the model carries', () => {
  it('renders one reading per hypothesis, in the model\'s own declaration order', () => {
    expect(readings().map(reading => reading.hypothesisId)).toEqual(Object.keys(HYPOTHESES))
  })

  for (const [hypothesisId, expectation] of Object.entries(HYPOTHESES)) {
    it(`derives ${expectation.finding.state} for ${hypothesisId} from the facts named under it`, () => {
      const reading = readings().find(entry => entry.hypothesisId === hypothesisId)
      expect(reading).toMatchObject(expectation.finding)
      expect(reading?.statement).toBe(model().hypotheses.find(entry => entry.id === hypothesisId)?.statement)
      expect(reading?.baseSha).toBe(model().hypotheses.find(entry => entry.id === hypothesisId)?.baseSha)
    })

    it(`says on the line for ${hypothesisId} what it read and what it did not`, () => {
      const line = lineFor(render(result()), hypothesisId)
      for (const said of expectation.says)
        expect(line, said).toContain(said)
      for (const omitted of expectation.omits)
        expect(line, omitted).not.toContain(omitted)
    })

    it(`reads ${hypothesisId} as a finding about the facts under it, never as a verdict on the repository`, () => {
      const line = lineFor(render(result()), hypothesisId)
      expect(line).not.toMatch(READS_AS_A_VERDICT)
      expect(pathsNamedIn(line)).toEqual(pathsCarriedBy(expectation.finding))
    })
  }

  it('keeps the two unknowns apart, rather than collapsing a hypothesis nobody supported into one that could not be read', () => {
    const output = render(result())
    const unevaluable = lineFor(output, 'ci-runs-the-harness-on-every-change')
    const nothingNamed = lineFor(output, 'deployed-as-a-single-container')
    expect(unevaluable).not.toBe(nothingNamed)
    expect(unevaluable.replace('ci-runs-the-harness-on-every-change', '')).not.toBe(nothingNamed.replace('deployed-as-a-single-container', ''))
  })

  it('names the path a fact could not be read from, rather than the id of the fact', () => {
    const reading = readings().find(entry => entry.hypothesisId === 'ci-runs-the-harness-on-every-change')
    expect(reading).toMatchObject({ state: 'unknown', reason: 'unevaluable', unevaluable: ['.github/workflows/ci.yml'] })
    expect(JSON.stringify(reading)).not.toContain('ci-runs-the-harness"')
  })

  it('reports a hypothesis whose evidence was uncommitted as standing on uncommitted evidence, and says nothing of the sort about the others', () => {
    const output = render(result())
    const uncommitted = lineFor(output, 'a-pnpm-workspace')
    const committed = lineFor(output, 'one-deployable-under-apps')
    expect(uncommitted).toContain('the evidence under it carried uncommitted changes when it was read')
    expect(committed).not.toContain('uncommitted changes')
    expect(uncommitted.replace('a-pnpm-workspace', '')).not.toBe(committed.replace('one-deployable-under-apps', ''))
  })
})

describe('neither register states a hypothesis reading as a verdict on the repository', () => {
  const SAMPLE_STATEMENT = 'This repository is a pnpm workspace'
  const SAMPLE_PATHS: [string, ...string[]] = ['apps/api/package.json']

  function hypothesisReadings(lore: Lore): string[] {
    return Object.entries(lore)
      .filter(([key]) => key.startsWith('hypothes'))
      .map(([, value]) => (typeof value === 'function' ? String(value(SAMPLE_STATEMENT, SAMPLE_PATHS)) : String(value)))
  }

  it('catches the wording it exists to catch, so a register passing it has been read', () => {
    expect('reads a thing \u2014 refuted by: apps/api/package.json').toMatch(READS_AS_A_VERDICT)
    expect(hypothesisReadings(PLAIN_LORE).length).toBe(hypothesisReadings(LORE).length)
    expect(hypothesisReadings(LORE).length).toBeGreaterThan(0)
  })

  for (const [register, lore] of [['arasaka', LORE], ['plain', PLAIN_LORE]] as const) {
    it(`states nothing in the ${register} register as a refutation of what the repository is`, () => {
      for (const reading of hypothesisReadings(lore))
        expect(reading, reading).not.toMatch(READS_AS_A_VERDICT)
    })
  }
})

describe('an empty hypotheses list never reads as a repository that was looked at', () => {
  const held: HypothesisReading[] = [{
    hypothesisId: 'a-pnpm-workspace',
    statement: 'This repository is a pnpm workspace',
    baseSha: '9f1c2a0e4b7d8c6a5f3e2d1c0b9a8f7e6d5c4b3a',
    evidenceClean: true,
    state: 'held',
  }]

  it('separates a model carrying no hypothesis from one whose hypotheses all hold', () => {
    const none = render(result({ hypotheses: [], youAreHere: { at: 'no-claim' } }))
    const standing = render(result({ hypotheses: held, youAreHere: { at: 'no-claim' } }))
    expect(none).not.toBe(standing)
    expect(none).toContain('construct.model.json names no hypothesis')
    expect(standing).not.toContain('construct.model.json names no hypothesis')
  })

  it('separates a model carrying no hypothesis from no model at all', () => {
    const none = render(result({ hypotheses: [], youAreHere: { at: 'no-claim' } }))
    const noModel = render(result({ checks: [], hypotheses: [], youAreHere: { at: 'no-model' } }))
    expect(none).not.toBe(noModel)
    expect(noModel).toContain('There is no construct.model.json here')
  })
})

describe('the hypotheses section in the plain register', () => {
  it('carries no emoji and no lore vocabulary with --plain', () => {
    const output = render(result())
    expect(output).not.toMatch(EMOJI)
    for (const word of LORE_VOCABULARY)
      expect(output, word).not.toContain(word)
  })

  it('keeps the you-are-here line last, below every hypothesis it reports', () => {
    const lines = render(result()).split('\n').filter(line => line.trim() !== '')
    expect(lines.at(-1)).toMatch(/^[ \t]*You are here: \S/)
    expect(lines.findIndex(line => line.includes('Hypotheses'))).toBeLessThan(lines.length - 1)
  })
})
