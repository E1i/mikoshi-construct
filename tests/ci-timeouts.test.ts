import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

const EXPECTED_TIMEOUT_MINUTES: Record<string, Record<string, number>> = {
  '.github/workflows/ci.yml': {
    'changes': 5,
    'checks': 5,
    'lint': 5,
    'typecheck': 5,
    'vitest': 8,
    'sandbox-list': 5,
    'browser': 15,
    'docs': 5,
    'package': 5,
    'contract-bump': 5,
    'acceptance': 5,
    'required': 5,
  },
  '.github/workflows/security.yml': {
    secrets: 3,
    dependencies: 3,
  },
}

function timeoutsOf(workflowPath: string): Record<string, unknown> {
  const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, workflowPath), 'utf8')) as { jobs: Record<string, { 'timeout-minutes'?: unknown }> }
  return Object.fromEntries(Object.entries(workflow.jobs).map(([id, job]) => [id, job['timeout-minutes']]))
}

describe('ci job timeouts', () => {
  it('every job in ci.yml and security.yml carries timeout-minutes', () => {
    for (const [workflowPath, expected] of Object.entries(EXPECTED_TIMEOUT_MINUTES))
      expect(timeoutsOf(workflowPath), workflowPath).toEqual(expected)
  })
})
