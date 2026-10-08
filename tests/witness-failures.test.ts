import type { ModelEvidence } from '../src/model/state.js'
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseModel } from '../src/model/schema.js'
import { evaluateFacts, WITHHELD_EVIDENCE } from '../src/model/state.js'
import { failedWitnesses } from '../src/model/witness-failures.js'

const READ: ModelEvidence = { reports: 'read', constructPaths: [] }
const SURFACE_TIME = new Date('2026-01-01T00:00:00Z')
const REPORT_TIME = new Date('2026-01-01T00:01:00Z')

const MODEL = parseModel(JSON.stringify({
  modelVersion: 5,
  facts: [
    { id: 'lid-tests', kind: 'report-covers', path: 'reports/all.json', surface: ['tests/lid.test.ts'], authoredBy: 'discovery' },
    { id: 'hinge-tests', kind: 'report-covers', path: 'reports/all.json', surface: ['tests/hinge.test.ts'], authoredBy: 'discovery' },
  ],
  claims: [],
  hypotheses: [],
  stages: [],
  nodes: [],
  links: [],
}), 'M')

function repository(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'witness-failures-')))
  for (const directory of ['tests', 'reports'])
    mkdirSync(path.join(root, directory))
  for (const file of ['tests/lid.test.ts', 'tests/hinge.test.ts']) {
    writeFileSync(path.join(root, file), 'x\n')
    utimesSync(path.join(root, file), SURFACE_TIME, SURFACE_TIME)
  }
  const result = (name: string, status: string): object => ({ name: path.join(root, `tests/${name}.test.ts`), status, assertionResults: [{ ancestorTitles: [], title: name, status }] })
  writeFileSync(path.join(root, 'reports/all.json'), JSON.stringify({ startTime: 1, testResults: [result('lid', 'passed'), result('hinge', 'failed')] }))
  utimesSync(path.join(root, 'reports/all.json'), REPORT_TIME, REPORT_TIME)
  return root
}

describe('a report-covers witness fails only on a failure among its own covering files', () => {
  it('names the witness whose covering test failed and not the one that shares its report', () => {
    const root = repository()
    expect([...failedWitnesses(MODEL, root, evaluateFacts(MODEL, root, READ), READ)]).toEqual(['hinge-tests'])
  })

  it('names no failure when the reader withholds the reports', () => {
    const root = repository()
    expect(failedWitnesses(MODEL, root, evaluateFacts(MODEL, root, READ), WITHHELD_EVIDENCE).size).toBe(0)
  })
})
