import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const BOUNDARY_PREFIX = 'boundary:'
const ROWS_AT_ZERO = ['project->ui', 'project->rules', 'project->decisions', 'project->session', 'project->intake', 'quality->ui'].map(edge => `${BOUNDARY_PREFIX}${edge}`)
const PROJECT_TO_MODEL = `${BOUNDARY_PREFIX}project->model`
const PROJECT_TO_MODEL_AFTER_THE_MOVE = 1

const recorded = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/ratchet.json'), 'utf8')) as Record<string, number>

describe('the cli module holds the CLI commands, as the ratchet that tests/contract/ratchet.test.ts holds equal to the tree records it', () => {
  it('the project and quality rows the move empties are gone from the ratchet', () => {
    expect(ROWS_AT_ZERO.filter(row => row in recorded)).toEqual([])
  })

  it('project->model keeps only the one import that stays in project', () => {
    expect(recorded[PROJECT_TO_MODEL]).toBe(PROJECT_TO_MODEL_AFTER_THE_MOVE)
  })

  it('no cli row enters the ratchet', () => {
    expect(Object.keys(recorded).filter(row => row.startsWith(`${BOUNDARY_PREFIX}cli->`))).toEqual([])
  })
})
