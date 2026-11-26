import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOUNDARY_PREFIX, boundaryNumbers, boundaryReport } from '../../scripts/contract/module-graph/boundary.js'
import { readRatchet } from '../../scripts/contract/ratchet.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const MEASUREMENT_TIMEOUT = 180_000
const ROWS_AT_ZERO = ['project->ui', 'project->rules', 'project->decisions', 'project->session', 'project->intake', 'quality->ui'].map(edge => `${BOUNDARY_PREFIX}${edge}`)
const PROJECT_TO_MODEL = `${BOUNDARY_PREFIX}project->model`
const PROJECT_TO_MODEL_AFTER_THE_MOVE = 1

describe('the cli module holds the CLI commands', () => {
  const measured = boundaryNumbers(boundaryReport(REPO_ROOT).violations)
  const recorded = readRatchet(REPO_ROOT)

  it('the project and quality rows the move empties measure 0 and are gone from the ratchet', { timeout: MEASUREMENT_TIMEOUT }, () => {
    expect(ROWS_AT_ZERO.filter(row => (measured[row] ?? 0) > 0)).toEqual([])
    expect(ROWS_AT_ZERO.filter(row => row in recorded)).toEqual([])
  })

  it('project->model keeps only the one import that stays in project', () => {
    expect(measured[PROJECT_TO_MODEL]).toBe(PROJECT_TO_MODEL_AFTER_THE_MOVE)
    expect(recorded[PROJECT_TO_MODEL]).toBe(PROJECT_TO_MODEL_AFTER_THE_MOVE)
  })

  it('no cli row enters the ratchet', () => {
    expect(Object.keys(measured).filter(row => row.startsWith(`${BOUNDARY_PREFIX}cli->`))).toEqual([])
  })
})
