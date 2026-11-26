import type { ReleaseSource } from '../../release-notes/release-body.js'
import type { SmokeEnv } from '../../release/version-pr-guard.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { InMemoryGh } from '../../ports/gh.js'
import { guardVersionPr, readSmokeStatus, SMOKE_NOT_READ, SMOKE_STATUS_CONTEXT } from '../../release/version-pr-guard.js'

const VERSION_PR = 'changeset-release/main'

const HEAD = '0123456789abcdef0123456789abcdef01234567'

const GITHUB_TOKEN_EXPRESSION = '{{ github.token }}'

const CI_WORKFLOW = path.resolve(import.meta.dirname, '../../../.github/workflows/ci.yml')

function consumedChangesets(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-smoke-gate-'))
  for (const name of ['README.md', 'config.json'])
    writeFileSync(path.join(dir, name), '')
  return dir
}

const SHORT_RELEASE = (): ReleaseSource => ({ version: '9.9.9', changelog: '# pkg\n\n## 9.9.9\n\n### Patch Changes\n\n- Short.\n' })

function versionPrRun(): SmokeEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-smoke-event-'))
  const event = path.join(dir, 'event.json')
  writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: HEAD } } }))
  return { GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event }
}

function statusesAnswering(statuses: unknown): InMemoryGh {
  return new InMemoryGh(args => args.some(arg => arg.startsWith(`repos/o/r/commits/${HEAD}/statuses`)) ? JSON.stringify(statuses) : { status: 1, stdout: '', stderr: 'unexpected call' })
}

function verdictOver(statuses: unknown): ReturnType<typeof guardVersionPr> {
  const smoke = readSmokeStatus(versionPrRun(), statusesAnswering(statuses).port())
  return guardVersionPr(VERSION_PR, consumedChangesets(), SHORT_RELEASE, smoke)
}

describe('a version pull request is red until its head carries a green consumer smoke', () => {
  it('a version PR whose head has no green consumer smoke is red', () => {
    const missing = verdictOver([{ context: 'CI / required', state: 'success' }])
    const failed = verdictOver([{ context: SMOKE_STATUS_CONTEXT, state: 'failure', description: 'red: launch git-commit' }])
    const pending = verdictOver([{ context: SMOKE_STATUS_CONTEXT, state: 'pending' }])
    const unread = guardVersionPr(VERSION_PR, consumedChangesets(), SHORT_RELEASE)

    for (const verdict of [missing, failed, pending, unread])
      expect(verdict.passed).toBe(false)
    expect(missing.lines.join('\n')).toContain(`${SMOKE_STATUS_CONTEXT} is missing`)
    expect(failed.lines.join('\n')).toContain('red: launch git-commit')
    expect(failed.lines.join('\n')).toContain('A capability with no green smoke run is not shipped as working.')
    expect(unread.lines.join('\n')).toContain(`${SMOKE_STATUS_CONTEXT} is unread`)
  })

  it('passes a version PR whose latest consumer smoke status on its head is success', () => {
    const verdict = verdictOver([{ context: SMOKE_STATUS_CONTEXT, state: 'success', description: '22 steps green' }, { context: SMOKE_STATUS_CONTEXT, state: 'failure' }])

    expect(verdict).toMatchObject({ passed: true })
    expect(verdict.lines.join('\n')).toContain('green consumer smoke')
  })

  it('reads the statuses of the pull request head, not of the merge commit', () => {
    const gh = statusesAnswering([])

    readSmokeStatus(versionPrRun(), gh.port())

    expect(gh.calls.map(call => call.args)).toEqual([['api', `repos/o/r/commits/${HEAD}/statuses?per_page=100`]])
  })

  it('is red when the statuses cannot be read or the run names no head', () => {
    const refused = new InMemoryGh(() => ({ status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' }))

    expect(readSmokeStatus(versionPrRun(), refused.port({ attempts: 1 })).state).toBe('unread')
    expect(readSmokeStatus({ GITHUB_REPOSITORY: 'o/r' }, statusesAnswering([]).port()).state).toBe('unread')
    expect(SMOKE_NOT_READ.state).not.toBe('success')
  })

  it('does not ask for a smoke on a feature pull request', () => {
    expect(guardVersionPr('feature', consumedChangesets(), SHORT_RELEASE).passed).toBe(true)
  })
})

describe('the guard reads only a state it knows as green', () => {
  it('a status state the guard does not recognise reads as red', () => {
    for (const state of ['neutral', 'SUCCESS', 'succeeded', null, 1]) {
      const smoke = readSmokeStatus(versionPrRun(), statusesAnswering([{ context: SMOKE_STATUS_CONTEXT, state, description: 'odd' }]).port())

      expect(smoke.state, String(state)).toBe('error')
      expect(smoke.note).toContain('unrecognised state')
      expect(guardVersionPr(VERSION_PR, consumedChangesets(), SHORT_RELEASE, smoke).passed, String(state)).toBe(false)
    }
  })
})

interface WorkflowStep {
  run?: string
  env?: Record<string, string>
}

interface Workflow {
  permissions: Record<string, string>
  jobs: Record<string, { steps: WorkflowStep[] }>
}

describe('the ci checks job can read the consumer smoke status', () => {
  it('the ci checks job gives the version pr guard step GH_TOKEN and grants statuses read', () => {
    const workflow = parse(readFileSync(CI_WORKFLOW, 'utf8')) as Workflow

    const guard = workflow.jobs.checks!.steps.filter(step => step.run?.includes('scripts/release/version-pr-guard.ts'))

    expect(guard).toHaveLength(1)
    expect(guard[0]!.env).toEqual({ GH_TOKEN: `$${GITHUB_TOKEN_EXPRESSION}` })
    expect(workflow.permissions).toEqual({ contents: 'read', statuses: 'read' })
  })
})
