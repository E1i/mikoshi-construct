import type { ModelEvidence } from '../src/model/state.js'
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectKnowledge } from '../src/commands/doctor/index.js'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState, WITHHELD_EVIDENCE } from '../src/model/state.js'
import { readModel } from '../src/model/write.js'

const P2A = path.resolve(import.meta.dirname, 'fixtures/engram/p2a-openappa')
const READ: ModelEvidence = { reports: 'read', constructPaths: [] }
const SURFACE_TIME = new Date('2026-01-01T00:00:00Z')
const REPORT_TIME = new Date('2026-01-01T00:01:00Z')

function node(id: string, supportedBy: string[]): object {
  return { id, label: id, stage: 'make', source: { path: 'src' }, supportedBy }
}

function document(): string {
  return JSON.stringify({
    modelVersion: 5,
    facts: [
      { id: 'press-file', kind: 'file-exists', path: 'src/press.ts', authoredBy: 'discovery' },
      { id: 'press-tests', kind: 'report-covers', path: 'reports/press.json', surface: ['tests/press.test.ts'], authoredBy: 'discovery' },
      { id: 'lid-tests', kind: 'report-covers', path: 'reports/lid.json', surface: ['tests/lid.test.ts'], authoredBy: 'discovery' },
      { id: 'gone-file', kind: 'file-exists', path: 'src/gone.ts', authoredBy: 'discovery' },
      { id: 'crack-tests', kind: 'report-covers', path: 'reports/crack.json', surface: ['tests/crack.test.ts'], authoredBy: 'discovery' },
    ],
    claims: [{ id: 'cracks', statement: 'the crack is tested', authoredBy: 'discovery', enforcement: null, verification: { mechanism: 'test', supportedBy: ['crack-tests'] } }],
    hypotheses: [{ id: 'cracked', statement: 'the crack is covered', authoredBy: 'discovery', baseSha: null, evidenceClean: true, supportedBy: ['crack-tests'] }],
    stages: [{ id: 'make', label: 'Make' }],
    nodes: [
      node('proven', ['press-file', 'press-tests']),
      node('partly-proven', ['press-tests', 'lid-tests']),
      node('only-written', ['press-file']),
      node('nothing-named', []),
      node('gone', ['press-tests', 'gone-file']),
      node('failing', ['press-file', 'crack-tests']),
    ],
    links: [],
  })
}

type Outcome = 'passed' | 'failed'

function writeReport(root: string, name: string, outcome: Outcome): void {
  const report = { startTime: 1, testResults: [{ name: path.join(root, `tests/${name}.test.ts`), status: outcome, assertionResults: [{ ancestorTitles: [], title: name, status: outcome }] }] }
  writeFileSync(path.join(root, `reports/${name}.json`), JSON.stringify(report))
  utimesSync(path.join(root, `reports/${name}.json`), REPORT_TIME, REPORT_TIME)
}

function repository(crack: Outcome = 'failed'): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'model-ability-')))
  for (const directory of ['src', 'tests', 'reports'])
    mkdirSync(path.join(root, directory))
  for (const file of ['src/press.ts', 'tests/press.test.ts', 'tests/lid.test.ts', 'tests/crack.test.ts']) {
    writeFileSync(path.join(root, file), 'x\n')
    utimesSync(path.join(root, file), SURFACE_TIME, SURFACE_TIME)
  }
  writeReport(root, 'press', 'passed')
  writeReport(root, 'crack', crack)
  return root
}

describe('a node is confirmed only by a witness that ran here and could have failed', () => {
  it('confirms a node whose test report covers it and whose every other fact holds', () => {
    const { nodes } = deriveModelState(parseModel(document(), 'M'), repository(), READ)
    expect(nodes.proven).toEqual({ status: 'confirmed', state: 'held' })
  })

  it('leaves a partly proven node an assumption, not run, when one of its witnesses has no report', () => {
    const { nodes } = deriveModelState(parseModel(document(), 'M'), repository(), READ)
    expect(nodes['partly-proven']).toEqual({ status: 'assumption', reason: 'not-run', state: 'unknown' })
  })

  it('never confirms a node that stands only on what the repository says', () => {
    const { nodes } = deriveModelState(parseModel(document(), 'M'), repository(), READ)
    expect(nodes['only-written']).toEqual({ status: 'assumption', reason: 'written-in-repo', state: 'unknown' })
    expect(nodes['nothing-named']).toEqual({ status: 'unknown', reason: 'written-in-repo', state: 'unknown' })
  })

  it('reads a node absent when a fact under it does not hold, even beside a passing witness', () => {
    const { nodes } = deriveModelState(parseModel(document(), 'M'), repository(), READ)
    expect(nodes.gone).toEqual({ status: 'unknown', reason: 'absent', state: 'unsupported' })
  })

  it('names the run elsewhere when the reader withholds the report a witness stands on', () => {
    const { nodes } = deriveModelState(parseModel(document(), 'M'), repository(), WITHHELD_EVIDENCE)
    expect(nodes.proven).toEqual({ status: 'assumption', reason: 'confirmed-elsewhere', state: 'unknown' })
    expect(nodes['partly-proven']).toEqual({ status: 'unknown', reason: 'confirmed-elsewhere', state: 'unknown' })
  })
})

describe('a covering test that ran and failed is no witness', () => {
  it('does not confirm a node whose report-covers witness ran and failed, and confirms it once the test passes', () => {
    expect(deriveModelState(parseModel(document(), 'M'), repository('failed'), READ).nodes.failing).toEqual({ status: 'unknown', reason: 'absent', state: 'unsupported' })
    expect(deriveModelState(parseModel(document(), 'M'), repository('passed'), READ).nodes.failing).toEqual({ status: 'confirmed', state: 'held' })
  })

  it('leaves the doctor verdict on the same failing report where report-covers alone puts it', () => {
    const model = parseModel(document(), 'M')
    const root = repository('failed')
    expect(deriveModelState(model, root, READ).facts['crack-tests']).toBe('holds')
    const projection = projectKnowledge(model, root, undefined, READ)
    expect(projection.stages.cracks?.verification).toEqual({ state: 'held' })
    expect(projection.hypotheses).toEqual([expect.objectContaining({ hypothesisId: 'cracked', state: 'held' })])
  })
})

describe('on P2a (OpenAPPA @ b6e7e98) a gate that passes vacuously is not confirmed', () => {
  for (const evidence of [WITHHELD_EVIDENCE, READ]) {
    it(`leaves appa describe --check and appa replay unconfirmed with reports ${evidence.reports}`, () => {
      const model = readModel(P2A)
      if (model == null)
        throw new Error(`${P2A} carries no model`)
      const { nodes } = deriveModelState(model, P2A, evidence)
      for (const id of ['verified-9', 'verified-5']) {
        expect(nodes[id]?.status).not.toBe('confirmed')
        expect(nodes[id]?.state).not.toBe('held')
        expect(nodes[id]).toEqual({ status: 'assumption', reason: 'written-in-repo', state: 'unknown' })
      }
    })
  }
})
