import type { ModelEvidence } from '../src/model/state.js'
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
    ],
    claims: [],
    hypotheses: [],
    stages: [{ id: 'make', label: 'Make' }],
    nodes: [
      node('proven', ['press-file', 'press-tests']),
      node('partly-proven', ['press-tests', 'lid-tests']),
      node('only-written', ['press-file']),
      node('nothing-named', []),
      node('gone', ['press-tests', 'gone-file']),
    ],
    links: [],
  })
}

function repository(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'model-ability-')))
  for (const directory of ['src', 'tests', 'reports'])
    mkdirSync(path.join(root, directory))
  for (const file of ['src/press.ts', 'tests/press.test.ts', 'tests/lid.test.ts']) {
    writeFileSync(path.join(root, file), 'x\n')
    utimesSync(path.join(root, file), SURFACE_TIME, SURFACE_TIME)
  }
  const report = { startTime: 1, testResults: [{ name: path.join(root, 'tests/press.test.ts'), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'presses', status: 'passed' }] }] }
  writeFileSync(path.join(root, 'reports/press.json'), JSON.stringify(report))
  utimesSync(path.join(root, 'reports/press.json'), REPORT_TIME, REPORT_TIME)
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
