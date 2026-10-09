import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCurrent } from '../../shift/current.js'

const OWNER_MERGES = readFileSync(path.resolve(import.meta.dirname, '../../../architecture/owner-merges.md'), 'utf8')

interface FakePr {
  number: number
  createdAt: string
  state?: string
  armed?: boolean
  decision?: 'auto' | 'owner'
  review?: string | null
  head?: string
  ci?: { conclusion: string, completedAt: string }[]
}

function listed(pr: FakePr): Record<string, unknown> {
  return {
    number: pr.number,
    createdAt: pr.createdAt,
    headRefOid: pr.head ?? `h${pr.number}`,
    mergeStateStatus: pr.state ?? 'BEHIND',
    autoMergeRequest: pr.armed === false ? null : {},
    statusCheckRollup: [
      ...(pr.ci ?? []).map(check => ({ name: 'quality', status: 'COMPLETED', ...check })),
      ...(pr.review === null ? [] : [{ context: 'review', state: pr.review ?? 'SUCCESS' }]),
    ],
    body: `#${pr.number} task [implement/runner/S/cheap/${pr.decision ?? 'auto'}] · depends — · blocks —`,
    files: [{ path: 'scripts/board/derive.ts' }],
  }
}

function setup(prs: FakePr[], options: { conflict?: number[], journal?: string } = {}) {
  const calls: string[][] = []
  const appended: string[] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    if (args[1] === 'list')
      return JSON.stringify(prs.map(listed))
    if (args[1] === 'update-branch' && options.conflict?.includes(Number(args[2])))
      throw new Error('merge conflict')
    if (args[1] === 'view')
      return JSON.stringify({ body: listed(prs.find(pr => String(pr.number) === args[2])!).body, headRefOid: 'new-head', files: [] })
    return ''
  }
  const carry = {
    gh,
    git: (args: string[]) => args[0] === 'range-diff' ? '1:  aaaaaaa = 1:  bbbbbbb own' : args[0] === 'rev-list' && args[1] === '--count' ? '1' : '',
    fetch: () => {},
    journal: () => `${JSON.stringify({ event: 'pr-review', task: '1', pr: 1, verdict: 'pass', commit: 'old' })}\n`,
    main: 'origin/main',
    publish: () => {},
  }
  const deps = { gh, carry, ownerMergesText: () => OWNER_MERGES, journal: () => options.journal ?? null, append: (text: string) => appended.push(text), now: () => new Date('2026-10-09T00:00:00Z') }
  return { calls, appended, deps }
}

const updated = (calls: string[][]): string[] => calls.filter(args => args[1] === 'update-branch').map(args => args[2]!)
const armedCalls = (calls: string[][]): string[][] => calls.filter(args => args[1] === 'merge')

describe('runCurrent', () => {
  it('updates the oldest armed BEHIND PR with its review carried and leaves the rest', () => {
    const { calls, deps } = setup([
      { number: 2, createdAt: '2026-10-02T00:00:00Z' },
      { number: 1, createdAt: '2026-10-01T00:00:00Z' },
      { number: 3, createdAt: '2026-10-03T00:00:00Z' },
    ])
    const result = runCurrent(deps)
    expect(updated(calls)).toEqual(['1'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).toContain('PR #1 updated with its review carried')
    expect(result.stdout.join('\n')).toContain('[shift:carry] PR #1 review pass carried from old to new-head')
  })

  it('says none is behind when every kept PR is current', () => {
    const { calls, deps } = setup([{ number: 1, createdAt: '2026-10-01T00:00:00Z', state: 'CLEAN' }])
    expect(runCurrent(deps).stdout).toEqual(['[shift:current] no kept pull request is behind'])
    expect(updated(calls)).toEqual([])
  })

  it('names a PR whose update is not clean and does not touch it', () => {
    const { calls, deps } = setup([{ number: 1, createdAt: '2026-10-01T00:00:00Z' }], { conflict: [1] })
    const result = runCurrent(deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual(['[shift:current] PR #1 not updated, left alone: merge conflict'])
    expect(calls.filter(args => args[1] === 'view')).toEqual([])
  })

  it('an owner-merge PR that is BEHIND is updated with its review carried and is never armed', () => {
    const { calls, deps } = setup([{ number: 1, createdAt: '2026-10-01T00:00:00Z', armed: false, decision: 'owner' }])
    const result = runCurrent(deps)
    expect(updated(calls)).toEqual(['1'])
    expect(armedCalls(calls)).toEqual([])
    expect(result.stdout.join('\n')).toContain('owner-merge, not armed')
    expect(result.stdout.join('\n')).toContain('carried from old to new-head')
  })

  it('a CLEAN owner-merge PR gets one ready-for-owner journal line with its merge command', () => {
    const pr: FakePr = { number: 5, createdAt: '2026-10-01T00:00:00Z', armed: false, decision: 'owner', state: 'CLEAN', head: 'abc1234' }
    const first = setup([pr])
    runCurrent(first.deps)
    expect(first.appended).toHaveLength(1)
    expect(JSON.parse(first.appended[0]!)).toMatchObject({ event: 'ready-for-owner', task: '5', pr: 5, head: 'abc1234', command: 'gh pr merge 5 --squash --match-head-commit abc1234' })
    const again = setup([pr], { journal: first.appended.join('') })
    runCurrent(again.deps)
    expect(again.appended).toEqual([])
    expect(armedCalls(first.calls)).toEqual([])
  })
  it('a pull request with a new head, no verdict and green CI gets a review-missing line after 15 minutes', () => {
    const pr: FakePr = { number: 7, createdAt: '2026-10-01T00:00:00Z', state: 'CLEAN', review: null, head: 'new7', ci: [{ conclusion: 'SUCCESS', completedAt: '2026-10-08T23:40:00Z' }] }
    const journal = `${JSON.stringify({ event: 'pr-review', task: '7', pr: 7, verdict: 'pass', commit: 'old7' })}\n`
    const first = setup([pr], { journal })
    const result = runCurrent(first.deps)
    expect(first.appended).toHaveLength(1)
    expect(JSON.parse(first.appended[0]!)).toMatchObject({ event: 'review-missing', task: '7', pr: 7, head: 'new7', greenSince: '2026-10-08T23:40:00.000Z' })
    expect(result.stdout.join('\n')).toContain('PR #7 head new7 has been green for more than 15 minutes with no review verdict')
    const again = setup([pr], { journal: journal + first.appended.join('') })
    runCurrent(again.deps)
    expect(again.appended).toEqual([])
  })

  it('a pull request green for less than 15 minutes, or with CI not green, stays silent', () => {
    const fresh = setup([{ number: 7, createdAt: '2026-10-01T00:00:00Z', state: 'CLEAN', review: null, ci: [{ conclusion: 'SUCCESS', completedAt: '2026-10-08T23:50:00Z' }] }])
    runCurrent(fresh.deps)
    expect(fresh.appended).toEqual([])
    const red = setup([{ number: 7, createdAt: '2026-10-01T00:00:00Z', state: 'CLEAN', review: null, ci: [{ conclusion: 'FAILURE', completedAt: '2026-10-08T23:00:00Z' }] }])
    runCurrent(red.deps)
    expect(red.appended).toEqual([])
  })

  it('a pull request with a verdict at its head stays silent', () => {
    const ci = [{ conclusion: 'SUCCESS', completedAt: '2026-10-08T23:00:00Z' }]
    const status = setup([{ number: 7, createdAt: '2026-10-01T00:00:00Z', state: 'CLEAN', review: 'FAILURE', head: 'h7', ci }])
    runCurrent(status.deps)
    expect(status.appended).toEqual([])
    const journal = `${JSON.stringify({ event: 'pr-review', task: '7', pr: 7, verdict: 'pass', commit: 'h7' })}\n`
    const recorded = setup([{ number: 7, createdAt: '2026-10-01T00:00:00Z', state: 'CLEAN', review: null, head: 'h7', ci }], { journal })
    runCurrent(recorded.deps)
    expect(recorded.appended).toEqual([])
  })
})
