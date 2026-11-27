import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const RECORD_PORTS = ['scripts/ports/serve-record.ts', 'scripts/ports/shift-settings.ts', 'scripts/ports/prepare-tree.ts'] as const
const PROJECT_TO_PORTS = 'boundary:project->ports'
const PORTS_TO_PROJECT = 'boundary:ports->project'
const PORTS_TO_PROJECT_AT_MOST = 2

function jsonAt<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T
}

it('project declares its record ports, project->ports is gone and ports->project is at most 2', () => {
  const { paths } = jsonAt<{ paths: string[] }>('declarations/modules/project.json')
  expect(RECORD_PORTS.filter(file => !paths.includes(file))).toEqual([])
  const ratchet = jsonAt<Record<string, number>>('contract/ratchet.json')
  expect(Object.keys(ratchet)).not.toContain(PROJECT_TO_PORTS)
  expect(ratchet[PORTS_TO_PROJECT] ?? 0).toBeLessThanOrEqual(PORTS_TO_PROJECT_AT_MOST)
})
