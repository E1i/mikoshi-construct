import type { FakeGh, World } from './fixtures/autopilot-world.js'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestPrReview, PR_REVIEW_EVENT, prReviewLine, runVerdict } from '../../shift/merge.js'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, depsOf, eventsOf, fakeGh, lines, newWorld } from './fixtures/autopilot-world.js'

const HEAD = 'a1b2c3d'
const STALE = 'f00dfee'

function chainGh(heads: { watched: () => string, armed: () => string } = { watched: () => HEAD, armed: () => HEAD }, files?: string[]): FakeGh {
  const inner = fakeGh({ 101: cardLine(1), 102: cardLine(2) })
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    const fields = args.at(-1)
    if (args[1] === 'view' && fields === 'headRefName,headRefOid,state')
      return JSON.stringify({ headRefName: `feat/${Number(args[2]) - 100}`, headRefOid: heads.watched(), state: 'OPEN' })
    if (args[1] === 'view' && fields === 'headRefOid,statusCheckRollup,files')
      return JSON.stringify({ headRefOid: heads.watched(), statusCheckRollup: [], files: [] })
    if (args[1] === 'view' && fields === 'body,headRefOid,files')
      return JSON.stringify({ ...JSON.parse(inner.gh(args)) as object, headRefOid: heads.armed(), ...(files === undefined ? {} : { files: files.map(file => ({ path: file })) }) })
    return inner.gh(args)
  }
  return { gh, calls, bus: inner.bus, handed: inner.handed }
}

function review(world: World, pr: number, verdict: 'pass' | 'changes', commit = HEAD): void {
  appendFileSync(world.journal, prReviewLine({ task: String(pr - 100), pr, verdict, commit }, new Date('2026-10-06T02:00:00.000Z')))
}

async function chainRun(world: World, chain: FakeGh, onSleep: (slept: number) => void, extra: string[] = []): Promise<number> {
  let slept = 0
  const sleep = (): Promise<void> => {
    onSleep(++slept)
    return Promise.resolve()
  }
  return runShift([world.shift, '--parking', world.parking, '--chain', ...extra], depsOf(world, chain.gh, captured(), { sleep, busMerge: chain.bus }))
}

function merges(chain: FakeGh): string[] {
  expect(chain.calls.filter(args => args[1] === 'merge')).toEqual([])
  return chain.handed.map(([pr]) => String(pr))
}

function armedAt(chain: FakeGh): string[] {
  return chain.handed.map(([, head]) => head)
}

const ONE = [{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101', touches: 'src/1/**' }]
const TWO = [...ONE, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102', touches: 'src/2/**' }]

describe('the chain arms a pull request after its review', () => {
  it('arms auto-merge only after the review verdict', async () => {
    const world = newWorld(ONE)
    const chain = chainGh()
    const armedBy: string[][] = []
    expect(await chainRun(world, chain, (slept) => {
      armedBy.push(merges(chain))
      if (slept === 2)
        review(world, 101, 'changes')
      if (slept === 3)
        review(world, 101, 'pass', STALE)
      if (slept === 4)
        review(world, 101, 'pass')
    })).toBe(0)
    expect(armedBy).toEqual([[], [], [], [], []])
    expect(merges(chain)).toEqual(['101'])
    expect(eventsOf(world, 'chain').map(line => line.step)).toEqual(['wait', 'reviewed', 'merged', 'end'])
    expect(eventsOf(world, 'chain')[1]).toMatchObject({ task: '1', pr: 101, armed: true })
    const report = readFileSync(path.join(world.shift, 'report-1.md'), 'utf8')
    expect(report.indexOf('PR #101 waits for its review verdict')).toBeLessThan(report.indexOf('PR #101 goes to the bus'))
    expect(readFileSync(path.join(world.shift, 'shift-report.md'), 'utf8')).toContain('| #1 task-1 | done | — | PR #101 |')
  })

  it('never arms a pull request with no pass verdict at its head, and says so when the wait runs out', async () => {
    const world = newWorld(ONE)
    const chain = chainGh()
    await chainRun(world, chain, () => review(world, 101, 'pass', STALE), ['--chain-wait', '3'])
    expect(merges(chain)).toEqual([])
    expect(eventsOf(world, 'chain').map(line => `${String(line.step)} ${String(line.reason ?? line.task)}`)).toEqual(['wait 1', 'end merge-timeout'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101, why: 'PR #101 not merged within 3 minutes; no review verdict pass at its head, so the chain never handed it to the bus' }])
    expect(readFileSync(path.join(world.shift, 'shift-report.md'), 'utf8')).toContain('| #1 task-1 | stop merge-timeout |')
  })
})

describe('the chain arms only the reviewed commit', () => {
  it('arms only the reviewed commit: a push after the pass arms nothing, and the arm carries the sha the verdict names', async () => {
    const pushed = newWorld(ONE)
    let head = HEAD
    const moved = chainGh({ watched: () => head, armed: () => head })
    await chainRun(pushed, moved, (slept) => {
      if (slept === 1) {
        review(pushed, 101, 'pass')
        head = STALE
      }
    }, ['--chain-wait', '3'])
    expect(merges(moved)).toEqual([])

    const raced = newWorld(ONE)
    const racing = chainGh({ watched: () => HEAD, armed: () => STALE })
    expect(await chainRun(raced, racing, () => review(raced, 101, 'pass'))).toBe(0)
    expect(armedAt(racing)).toEqual([HEAD])
  })

  it('arms only the reviewed commit: --verdict without --commit, or with a commit that is not the head, is refused and writes nothing', () => {
    const world = newWorld(ONE)
    const before = readFileSync(world.journal, 'utf8')
    const deps = { gh: chainGh().gh, journal: world.journal, append: appendFileSync, now: () => new Date() }
    const missing = runVerdict(['101', '--verdict', 'pass'], deps)
    expect(missing).toMatchObject({ exitCode: 1, stdout: [] })
    expect(missing.stderr[0]).toContain('--commit <sha>')
    const notHead = runVerdict(['101', '--verdict', 'pass', '--commit', STALE], deps)
    expect(notHead).toMatchObject({ exitCode: 1, stdout: [] })
    expect(notHead.stderr[0]).toBe(`[shift:verdict] PR #101 head is ${HEAD}, not ${STALE}; nothing recorded`)
    expect(readFileSync(world.journal, 'utf8')).toBe(before)
  })
})

describe('a pipeline of two cards', () => {
  it('merges each pull request only after its review', async () => {
    const world = newWorld(TWO)
    const chain = chainGh()
    expect(await chainRun(world, chain, (slept) => {
      if (slept === 1)
        review(world, 102, 'pass')
      if (slept === 3)
        review(world, 101, 'pass')
    })).toBe(0)
    expect(merges(chain)).toEqual(['102', '101'])
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
    const result = runVerdict(['101', '--verdict', 'pass', '--commit', HEAD], { gh: chainGh().gh, journal: world.journal, append: appendFileSync, now: () => new Date('2026-10-06T03:00:00.000Z') })
    expect(result).toEqual({ stdout: ['[shift:verdict] #1 PR #101 pass at a1b2c3d; a chain arms its auto-merge only after a pass at its head, and only at a1b2c3d'], stderr: [], exitCode: 0 })
    expect(latestPrReview(journal(world), '1', 101)).toEqual({ task: '1', pr: 101, verdict: 'pass', commit: HEAD })
  })

  it('refuses a verdict that is not pass or changes, and a pull request it cannot read, recording nothing', () => {
    const world = newWorld(ONE)
    const before = journal(world)
    const deps = { gh: chainGh().gh, journal: world.journal, append: appendFileSync, now: () => new Date() }
    expect(runVerdict(['101', '--verdict', 'maybe', '--commit', HEAD], deps).exitCode).toBe(1)
    expect(runVerdict(['999', '--verdict', 'pass', '--commit', HEAD], deps).stderr[0]).toMatch(/^\[shift:verdict\] PR #999 not read: /)
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

describe('review depth follows risk', () => {
  const BY_RISK = [
    { touches: '.claude/agents/review.md', risk: 'R1', depth: 'full' },
    { touches: 'scripts/shift/**', risk: 'R2', depth: 'full' },
    { touches: 'src/1/**', risk: 'R3', depth: 'diff' },
    { touches: 'docs/1.md', risk: 'R4', depth: 'none' },
  ] as const

  it.each(BY_RISK)('the chain in step wait reads $risk as review $depth', async ({ touches, risk, depth }) => {
    const world = newWorld([{ ...ONE[0]!, touches }])
    const chain = chainGh()
    await chainRun(world, chain, () => {}, ['--chain-wait', '3'])
    expect(eventsOf(world, 'chain')[0]).toMatchObject({ step: 'wait', task: '1', pr: 101, review: depth })
    const report = readFileSync(path.join(world.shift, 'report-1.md'), 'utf8')
    if (depth === 'none') {
      expect(merges(chain)).toEqual(['101'])
      expect(report).not.toContain('waits for its review verdict')
      return
    }
    expect(merges(chain)).toEqual([])
    expect(report).toContain(`PR #101 waits for its review verdict, a ${depth} review at risk ${risk}`)
  })
})

describe('review depth follows the changed files', () => {
  const R4_CARD = { ...ONE[0]!, touches: 'docs/1.md' }
  const BOTH_HEADS = { watched: () => HEAD, armed: () => HEAD }

  it.each([
    { files: ['src/materialize/plan.ts'], risk: 'R1', depth: 'full' },
    { files: ['docs/1.md', 'src/atlas/x.ts'], risk: 'R3', depth: 'diff' },
    { files: [], risk: 'R1', depth: 'full' },
  ])('a card of R4 touches whose changed files are $files waits for a $depth review verdict', async ({ files, risk, depth }) => {
    const world = newWorld([R4_CARD])
    const chain = chainGh(BOTH_HEADS, files)
    await chainRun(world, chain, () => {}, ['--chain-wait', '3'])
    expect(merges(chain)).toEqual([])
    expect(eventsOf(world, 'chain')[0]).toMatchObject({ step: 'wait', task: '1', pr: 101, review: depth })
    expect(readFileSync(path.join(world.shift, 'report-1.md'), 'utf8')).toContain(`PR #101 waits for its review verdict, a ${depth} review at risk ${risk}`)
  })

  it('the R4 card goes to the bus at the head, with no gh pr merge', async () => {
    const world = newWorld([R4_CARD])
    const chain = chainGh(BOTH_HEADS, ['docs/1.md', 'tests/x.test.ts'])
    await chainRun(world, chain, () => {}, ['--chain-wait', '3'])
    expect(merges(chain)).toEqual(['101'])
    expect(armedAt(chain)).toEqual([HEAD])
    expect(eventsOf(world, 'chain')[0]).toMatchObject({ step: 'wait', task: '1', pr: 101, review: 'none' })
  })
})
