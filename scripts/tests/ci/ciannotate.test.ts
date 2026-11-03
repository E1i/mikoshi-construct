import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Step { run?: string }
interface Job { steps: Step[] }

const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> }

const SHARD_RUN = /\bpnpm test --shard=/

function shardRunLines(): string[] {
  return Object.values(workflow.jobs).flatMap(({ steps }) => steps
    .flatMap(step => (step.run ?? '').split('\n'))
    .filter(line => SHARD_RUN.test(line)))
}

function reporters(line: string): string[] {
  return [...line.matchAll(/--reporter=(\S+)/g)].map(match => match[1]!)
}

describe('ci.yml vitest shards annotate their failures', () => {
  it('every vitest shard step in ci.yml reports through github-actions beside default', () => {
    const lines = shardRunLines()
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines)
      expect(reporters(line)).toEqual(expect.arrayContaining(['default', 'github-actions', 'blob']))
  })
})
