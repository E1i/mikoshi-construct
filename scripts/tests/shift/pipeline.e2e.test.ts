import type { World } from './fixtures/autopilot-world.js'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestPrReview, PR_REVIEW_EVENT, prReviewLine, runVerdict } from '../../shift/merge.js'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, depsOf, eventsOf, fakeGh, lines, newWorld } from './fixtures/autopilot-world.js'

const HEAD = 'a1b2c3d'
const STALE = 'f00dfee'

function chainGh(): { gh: (args: string[]) => string, calls: string[][] } {
  const inner = fakeGh({ 101: cardLine(1), 102: cardLine(2) })
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    const fields = args.at(-1)
    if (args[1] === 'view' && fields === 'headRefName,headRefOid,state')
      return JSON.stringify({ headRefName: `feat/${Number(args[2]) - 100}`, headRefOid: HEAD, state: 'OPEN' })
    if (args[1] === 'view' && fields === 'headRefOid,statusCheckRollup,files')
      return JSON.stringify({ headRefOid: HEAD, statusCheckRollup: [], files: [] })
    return inner.gh(args)
  }
  return { gh, calls }
}

function review(world: World, pr: number, verdict: 'pass' | 'changes', commit = HEAD): void {
  appendFileSync(world.journal, prReviewLine({ task: String(pr - 100), pr, verdict, commit }, new Date('2026-10-06T02:00:00.000Z')))
}

async function chainRun(world: World, gh: (args: string[]) => string, onSleep: (slept: number) => void, extra: string[] = []): Promise<number> {
  let slept = 0
  const sleep = (): Promise<void> => {
    onSleep(++slept)
    return Promise.resolve()
  }
  return runShift([world.shift, '--parking', world.parking, '--chain', ...extra], depsOf(world, gh, captured(), { sleep }))
}

function merges(calls: string[][]): string[] {
  return calls.filter(args => args[1] === 'merge').map(args => args[2]!)
}

const ONE = [{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }]
const TWO = [...ONE, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' }]

describe('the chain arms a pull request after its review', () => {
  it('arms auto-merge only after the review verdict', async () => {
    const world = newWorld(ONE)
    const { gh, calls } = chainGh()
    const armedBy: string[][] = []
    expect(await chainRun(world, gh, (slept) => {
      armedBy.push(merges(calls))
      if (slept === 2)
        review(world, 101, 'changes')
      if (slept === 3)
        review(world, 101, 'pass', STALE)
      if (slept === 4)
        review(world, 101, 'pass')
    })).toBe(0)
    expect(armedBy).toEqual([[], [], [], []])
    expect(merges(calls)).toEqual(['101'])
    expect(eventsOf(world, 'chain').map(line => line.step)).toEqual(['wait', 'reviewed', 'merged', 'end'])
    expect(eventsOf(world, 'chain')[1]).toMatchObject({ task: '1', pr: 101, armed: true })
    const report = readFileSync(path.join(world.shift, 'report-1.md'), 'utf8')
    expect(report.indexOf('PR #101 waits for its review verdict')).toBeLessThan(report.indexOf('auto-merge armed on PR #101'))
    expect(readFileSync(path.join(world.shift, 'shift-report.md'), 'utf8')).toContain('| #1 task-1 | done | — | PR #101 |')
  })

  it('never arms a pull request with no pass verdict at its head, and says so when the wait runs out', async () => {
    const world = newWorld(ONE)
    const { gh, calls } = chainGh()
    await chainRun(world, gh, () => review(world, 101, 'pass', STALE), ['--chain-wait', '3'])
    expect(merges(calls)).toEqual([])
    expect(eventsOf(world, 'chain').map(line => `${String(line.step)} ${String(line.reason ?? line.task)}`)).toEqual(['wait 1', 'end merge-timeout'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101, why: 'PR #101 not merged within 3 minutes; no review verdict pass at its head, so the chain never armed it' }])
    expect(readFileSync(path.join(world.shift, 'shift-report.md'), 'utf8')).toContain('| #1 task-1 | stop merge-timeout |')
  })
})

describe('a pipeline of two cards', () => {
  it('merges each pull request only after its review', async () => {
    const world = newWorld(TWO)
    const { gh, calls } = chainGh()
    expect(await chainRun(world, gh, (slept) => {
      if (slept === 1)
        review(world, 102, 'pass')
      if (slept === 3)
        review(world, 101, 'pass')
    })).toBe(0)
    expect(merges(calls)).toEqual(['102', '101'])
    const journal = lines(world.journal)
    for (const task of ['1', '2']) {
      const reviewed = journal.findIndex(line => line.event === PR_REVIEW_EVENT && line.task === task)
      const merged = journal.findIndex(line => line.event === 'merge' && line.task === task)
      expect(reviewed).toBeGreaterThan(-1)
      expect(merged).toBeGreaterThan(reviewed)
    }
    expect(eventsOf(world, 'chain').map(line => `${String(line.step)} ${String(line.task ?? line.reason)}`)).toEqual(['wait 1', 'next 2', 'wait 2', 'reviewed 2', 'merged 2', 'reviewed 1', 'merged 1', 'end no-eligible'])
  })
})

describe('pnpm shift:merge <N> --verdict', () => {
  const journal = (world: World): string => readFileSync(world.journal, 'utf8')

  it('records the verdict for the card on the first line of the pull request, at its head', () => {
    const world = newWorld(ONE)
    const result = runVerdict(['101', '--verdict', 'pass'], { gh: chainGh().gh, journal: world.journal, append: appendFileSync, now: () => new Date('2026-10-06T03:00:00.000Z') })
    expect(result).toEqual({ stdout: ['[shift:verdict] #1 PR #101 pass at a1b2c3d; a chain arms its auto-merge only after a pass at its head'], stderr: [], exitCode: 0 })
    expect(latestPrReview(journal(world), '1', 101)).toEqual({ task: '1', pr: 101, verdict: 'pass', commit: HEAD })
  })

  it('refuses a verdict that is not pass or changes, and a pull request it cannot read, recording nothing', () => {
    const world = newWorld(ONE)
    const before = journal(world)
    const deps = { gh: chainGh().gh, journal: world.journal, append: appendFileSync, now: () => new Date() }
    expect(runVerdict(['101', '--verdict', 'maybe'], deps).exitCode).toBe(1)
    expect(runVerdict(['999', '--verdict', 'pass'], deps).stderr[0]).toMatch(/^\[shift:verdict\] PR #999 not read: /)
    expect(journal(world)).toBe(before)
  })

  it('reads the latest verdict for the card and pull request, and ignores other lines', () => {
    const text = [
      prReviewLine({ task: '1', pr: 101, verdict: 'pass', commit: STALE }, new Date(0)),
      prReviewLine({ task: '1', pr: 101, verdict: 'changes', commit: HEAD }, new Date(0)),
      prReviewLine({ task: '2', pr: 102, verdict: 'pass', commit: HEAD }, new Date(0)),
      '{"event":"review","task":"1","verdict":"pass"}\n',
      'not json\n',
    ].join('')
    expect(latestPrReview(text, '1', 101)).toEqual({ task: '1', pr: 101, verdict: 'changes', commit: HEAD })
    expect(latestPrReview(text, '1', 102)).toBeUndefined()
  })
})
