import type { JobResult, Needs } from '../../ci/required.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { blockingJobs, DOCS_ONLY_JOB, isDocsOnly, SKIPPED_WHEN_DOCS_ONLY } from '../../ci/required.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Job { needs?: string | string[], if?: string, steps: { run?: string }[], outputs?: Record<string, string> }
const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> }
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

function needs(docsOnly: boolean, results: Partial<Record<string, JobResult>> = {}): Needs {
  return {
    [DOCS_ONLY_JOB]: { result: 'success', outputs: { 'docs-only': String(docsOnly) } },
    'quality': { result: results.quality ?? 'success' },
    'contract-bump': { result: results['contract-bump'] ?? 'success' },
    [SKIPPED_WHEN_DOCS_ONLY]: { result: results[SKIPPED_WHEN_DOCS_ONLY] ?? 'success' },
  }
}

describe('docs-only classification', () => {
  it('reads a pull request of changesets, docs and the changelog as docs-only', () => {
    expect(isDocsOnly(['.changeset/a.md'])).toBe(true)
    expect(isDocsOnly(['.changeset/a.md', 'docs/guide/x.md', 'CHANGELOG.md'])).toBe(true)
  })

  it('reads package.json, which templates embed as the construct version, as not docs-only', () => {
    expect(isDocsOnly(['.changeset/a.md', 'CHANGELOG.md', 'package.json'])).toBe(false)
  })

  it('reads a near-miss path as not docs-only', () => {
    expect(isDocsOnly(['docs.md'])).toBe(false)
    expect(isDocsOnly(['templates/docs/x.md'])).toBe(false)
    expect(isDocsOnly(['CHANGELOG.md.bak'])).toBe(false)
  })

  it('reads no paths at all as not docs-only', () => {
    expect(isDocsOnly([])).toBe(false)
  })
})

describe('the required verdict', () => {
  it('is green on a docs-only pull request whose preset matrix was skipped', () => {
    expect(blockingJobs(needs(true, { [SKIPPED_WHEN_DOCS_ONLY]: 'skipped' }))).toEqual([])
  })

  it('is red when the preset matrix was skipped on a pull request that is not docs-only', () => {
    expect(blockingJobs(needs(false, { [SKIPPED_WHEN_DOCS_ONLY]: 'skipped' }))).toEqual([`${SKIPPED_WHEN_DOCS_ONLY}: skipped`])
  })

  it('is red when a preset job failed or was cancelled', () => {
    expect(blockingJobs(needs(false, { [SKIPPED_WHEN_DOCS_ONLY]: 'failure' }))).toEqual([`${SKIPPED_WHEN_DOCS_ONLY}: failure`])
    expect(blockingJobs(needs(false, { [SKIPPED_WHEN_DOCS_ONLY]: 'cancelled' }))).toEqual([`${SKIPPED_WHEN_DOCS_ONLY}: cancelled`])
  })

  it('is red when quality fails on a docs-only pull request', () => {
    expect(blockingJobs(needs(true, { quality: 'failure', [SKIPPED_WHEN_DOCS_ONLY]: 'skipped' }))).toEqual(['quality: failure'])
  })

  it('accepts no skip other than the preset matrix on a docs-only pull request', () => {
    expect(blockingJobs(needs(true, { 'quality': 'skipped', 'contract-bump': 'skipped' }))).toEqual(['quality: skipped', 'contract-bump: skipped'])
  })

  it('is red when the classification itself failed', () => {
    expect(blockingJobs({ ...needs(false, { [SKIPPED_WHEN_DOCS_ONLY]: 'skipped' }), [DOCS_ONLY_JOB]: { result: 'failure', outputs: {} } })).toEqual([`${DOCS_ONLY_JOB}: failure`, `${SKIPPED_WHEN_DOCS_ONLY}: skipped`])
  })

  it('is red when it was given no job results', () => {
    expect(blockingJobs({})).toHaveLength(1)
  })
})

describe('ci.yml wiring', () => {
  it('makes required wait on every other job, whatever their results', () => {
    const others = Object.keys(workflow.jobs).filter(job => job !== 'required')
    expect(others.length).toBeGreaterThan(1)
    expect([workflow.jobs.required!.needs].flat().sort()).toEqual(others.sort())
    expect(workflow.jobs.required!.if).toBe('always()')
    expect(workflow.jobs.required!.steps.map(step => step.run ?? '').join('\n')).toContain('scripts/ci/verdict.ts')
  })

  it('skips only the preset matrix on docs-only, and quality runs the docs build on every change', () => {
    const conditional = Object.entries(workflow.jobs).filter(([, job]) => job.if !== undefined).map(([name]) => name)
    expect(conditional.sort()).toEqual([SKIPPED_WHEN_DOCS_ONLY, 'required'].sort())
    expect(workflow.jobs[SKIPPED_WHEN_DOCS_ONLY]!.if).toBe(`needs.${DOCS_ONLY_JOB}.outputs.docs-only != 'true'`)
    expect(workflow.jobs[DOCS_ONLY_JOB]!.outputs).toHaveProperty('docs-only')
    expect(workflow.jobs.quality!.steps.map(step => step.run ?? '')).toContain('pnpm run quality')
    expect(manifest.scripts.quality).toContain('pnpm docs:pending')
  })
})
