import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../bus/db.js'
import type { CleanUpdate } from '../../bus/update-done.js'
import type { ReviewStatus, StatusPublisher } from '../../ghosts/verdict.js'
import type { MergeResult } from '../../shift/merge.js'
import type { World } from './fixtures/autopilot-world.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { POLICY_DENIED } from '../../bus/inbox.js'
import { NetWatch } from '../../bus/netwatch.js'
import { BusTick } from '../../bus/run.js'
import { cleanUpdatesOf } from '../../bus/update-done.js'
import { chainBusMerge } from '../../shift/chain-bus.js'
import { busMerge, HANDED_TO_THE_BUS, isListed, runCarry, runMerge, runUpdated, runVerdict } from '../../shift/merge.js'
import { runShift } from '../../shift/shift.js'
import { cardBody as busCardBody, Clock, FakeGitHub, sha } from '../bus/github-fake.js'
import { detectReview } from '../bus/review-detection.js'
import { captured, depsOf, eventsOf, fakeGh, newWorld, cardLine as parkedCardLine } from './fixtures/autopilot-world.js'
import { prReviewLine } from './fixtures/pr-review-line.js'

const OWNER_MERGES = readFileSync(path.resolve(import.meta.dirname, '../../../architecture/owner-merges.md'), 'utf8')
const GHOSTS_FILES = readFileSync(path.resolve(import.meta.dirname, '../../../architecture/ghosts-files.md'), 'utf8')
const HEAD = 'a1b2c3d'

function cardLine(decision: 'owner' | 'auto'): string {
  return `#7 shift-task [implement/runner/S/cheap/${decision}] · depends — · blocks —`
}

function run(body: string, files: string[]): { calls: string[][], result: ReturnType<typeof runMerge> } {
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    return args[1] === 'view' ? JSON.stringify({ body, headRefOid: HEAD, files: files.map(file => ({ path: file })) }) : ''
  }
  return { calls, result: runMerge(['42'], { gh, ownerMergesText: () => OWNER_MERGES }) }
}

function armed(calls: string[][], result: ReturnType<typeof runMerge>): boolean {
  expect(calls.filter(args => args[1] !== 'view')).toEqual([])
  return result.stdout.some(line => HANDED_TO_THE_BUS.test(line))
}

describe('runMerge', () => {
  it('the merge step calls no gh pr merge and arms no auto-merge', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts'])
    expect(calls).toEqual([['pr', 'view', '42', '-R', 'E1i/mikoshi-construct', '--json', 'body,headRefOid,files']])
    expect(calls.flat()).not.toContain('--auto')
    expect(result).toEqual({ stdout: [`[shift:merge] decision auto, no owner path — PR #42 goes to the bus at ${HEAD}; the chain waits for its merge.done`], stderr: [], exitCode: 0 })
  })

  it('hands nothing to the bus for a card whose decision is owner, even when every path is plain', () => {
    const { calls, result } = run(`${cardLine('owner')}\n\nbody`, ['scripts/board/derive.ts'])
    expect(armed(calls, result)).toBe(false)
    expect(result.stdout).toEqual(['[shift:merge] decision owner — PR #42 and the report, merge is Eli\'s'])
  })

  it('hands the head sha to the bus for decision auto when every path is plain', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', 'scripts/ghosts/entry.ts'])
    expect(armed(calls, result)).toBe(true)
    expect(result.stdout[0]).toContain(`PR #42 goes to the bus at ${HEAD}`)
    expect(result.exitCode).toBe(0)
  })

  it('hands nothing to the bus for decision auto when one path is owner-merged, and names that path', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', '.claude/agents/implementer.md'])
    expect(armed(calls, result)).toBe(false)
    expect(result.stdout).toEqual(['[shift:merge] owner path .claude/agents/implementer.md — merge is Eli\'s'])
  })

  it('a PR touching .claude/settings.json, .claude/skills or .claude/commands is owner-merged and never handed to the bus', () => {
    for (const file of ['.claude/settings.json', '.claude/skills/x/SKILL.md', '.claude/commands/x.md']) {
      const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', file])
      expect(armed(calls, result)).toBe(false)
      expect(result.stdout).toEqual([`[shift:merge] owner path ${file} — merge is Eli's`])
    }
  })

  it('a PR touching .claude/hooks or .claude/eddies.json is owner-merged and never handed to the bus', () => {
    for (const file of ['.claude/hooks/role-guard.mjs', '.claude/eddies.json']) {
      const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', file])
      expect(armed(calls, result)).toBe(false)
      expect(result.stdout).toEqual([`[shift:merge] owner path ${file} — merge is Eli's`])
    }
  })

  it('a PR touching only .claude/statusline.sh is not listed', () => {
    const { calls, result } = run(cardLine('auto'), ['.claude/statusline.sh'])
    expect(armed(calls, result)).toBe(true)
  })

  it('a PR touching only architecture/ghosts-files.md is not listed', () => {
    const { calls, result } = run(cardLine('auto'), ['architecture/ghosts-files.md'])
    expect(isListed('architecture/ghosts-files.md', GHOSTS_FILES)).toBe(false)
    expect(armed(calls, result)).toBe(true)
  })

  it('hands nothing to the bus for a pull request that changes src/ with no matrix count line, and names the path', () => {
    const { calls, result } = run(cardLine('auto'), ['src/program.ts', 'scripts/board/derive.ts'])
    expect(armed(calls, result)).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual(['[shift:merge] PR #42 changes src/program.ts and its description has no code matrix count line ■ n □ n · n (architecture/code-matrix.md); not handed to the bus'])
  })

  it('hands nothing to the bus for a pull request that changes templates/ with no matrix count line', () => {
    const { calls, result } = run(cardLine('auto'), ['templates/base/architecture/principles.md'])
    expect(armed(calls, result)).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('hands to the bus a pull request that changes src/ and ends with the matrix count line', () => {
    const { calls, result } = run(`${cardLine('auto')}\n\n|    | BD | E9 | FF |\n| 7A | ■ | · | · |\n\n■ 1 □ 0 · 5`, ['src/program.ts'])
    expect(armed(calls, result)).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('hands to the bus a pull request that changes only scripts/ with no matrix', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts'])
    expect(armed(calls, result)).toBe(true)
  })

  it('refuses a pull request whose first line is not a card', () => {
    const { calls, result } = run('Some description', ['scripts/board/derive.ts'])
    expect(armed(calls, result)).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('refuses an argument that is not a pull request number', () => {
    expect(runMerge(['#42'], { gh: () => '', ownerMergesText: () => OWNER_MERGES }).exitCode).toBe(1)
  })
})

describe('the chain waits for the bus', () => {
  const FULL_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const MERGE_COMMIT = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'

  function busWith(event: Pick<BusEvent, 'type' | 'actor' | 'payload'>): string {
    const busPath = path.join(mkdtempSync(path.join(tmpdir(), 'shift-merge-bus-')), 'bus.db')
    const db = openBus(busPath)
    appendEvent(db, { ts: '2026-10-06T01:30:00.000Z', cardId: 1, pr: 101, head: FULL_HEAD, dedupeKey: `${event.type}:merge:101`, legacy: false, ...event })
    db.close()
    return busPath
  }

  function chainGh(): { gh: (args: string[]) => string, calls: string[][] } {
    const inner = fakeGh({ 101: parkedCardLine(1) })
    const calls: string[][] = []
    const gh = (args: string[]): string => {
      calls.push(args)
      const fields = args.at(-1)
      if (args[1] === 'view' && fields === 'headRefName,headRefOid,state')
        return JSON.stringify({ headRefName: 'feat/1', headRefOid: FULL_HEAD, state: 'OPEN' })
      if (args[1] === 'view' && fields === 'headRefOid,statusCheckRollup,files')
        return JSON.stringify({ headRefOid: FULL_HEAD, statusCheckRollup: [], files: [] })
      if (args[1] === 'view' && fields === 'body,headRefOid,files')
        return JSON.stringify({ ...JSON.parse(inner.gh(args)) as object, headRefOid: FULL_HEAD })
      return inner.gh(args)
    }
    return { gh, calls }
  }

  async function chainOnBus(busPath: string): Promise<{ world: World, calls: string[][], errors: string[] }> {
    const world = newWorld([{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101', touches: 'src/1/**' }])
    appendFileSync(world.journal, prReviewLine({ task: '1', pr: 101, verdict: 'pass', commit: FULL_HEAD }, new Date('2026-10-06T01:10:00.000Z')))
    const { gh, calls } = chainGh()
    const errors: string[] = []
    await runShift([world.shift, '--parking', world.parking, '--chain', '--chain-wait', '30'], depsOf(world, gh, captured(), { sleep: async () => {}, busMerge: chainBusMerge(busPath, line => errors.push(line)) }))
    return { world, calls, errors }
  }

  function steps(world: World): string[] {
    return eventsOf(world, 'chain').map(line => `${String(line.step)} ${String(line.reason ?? line.task)}`)
  }

  it('the chain sees merge.done from the bus for its PR head and closes', async () => {
    const busPath = busWith({ type: MERGE_DONE, actor: 'worker:merge:s1', payload: { commit: MERGE_COMMIT, rule: 'auto' } })
    const { world, calls, errors } = await chainOnBus(busPath)
    expect(calls.filter(args => args[1] === 'merge')).toEqual([])
    expect(steps(world)).toEqual(['wait 1', 'reviewed 1', 'merged 1', 'end no-eligible'])
    expect(eventsOf(world, 'stop')).toEqual([])
    expect(errors).toEqual([])
    const db = openBus(busPath)
    expect([busMerge(db, 101, FULL_HEAD), busMerge(db, 101, MERGE_COMMIT)]).toEqual([{ kind: 'merged', commit: MERGE_COMMIT, rule: 'auto' }, { kind: 'waiting' }])
    db.close()
  })

  it('a policy.denied from the bus stops the chain with the denial reason, not a timeout', async () => {
    const detail = 'scripts/shift/** reads R2 and the card is cheap'
    const busPath = busWith({ type: POLICY_DENIED, actor: 'policy', payload: { command: 'merge', kind: 'authority', rule: 'owner_by_risk', detail } })
    const { world, calls } = await chainOnBus(busPath)
    expect(calls.filter(args => args[1] === 'merge')).toEqual([])
    expect(steps(world)).toEqual(['wait 1', 'reviewed 1', 'end policy-denied'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101, why: `PR #101 at ${FULL_HEAD} not merged by the bus: policy.denied owner_by_risk: ${detail}` }])
  })

  it('a technical policy.denied leaves the chain waiting for the bus to retry', () => {
    const busPath = busWith({ type: POLICY_DENIED, actor: 'policy', payload: { command: 'merge', kind: 'technical', reason: 'ci_not_ready', detail: 'CI is pending' } })
    expect(chainBusMerge(busPath, () => {})(101, FULL_HEAD)).toEqual({ kind: 'waiting' })
  })
})

describe('isListed', () => {
  const text = '| file | kind |\n|---|---|\n| `scripts/ghosts/a.ts` | ghosts |\n| `scripts/ghosts/b.ts` | plain |\n'

  it('finds a path of either kind in ghosts-files.md, and not an unlisted one', () => {
    expect([isListed('scripts/ghosts/a.ts', text), isListed('scripts/ghosts/b.ts', text), isListed('scripts/ghosts/c.ts', text)]).toEqual([true, true, false])
  })

  it('reads a ghosts row and a plain row of the real ghosts-files.md as listed', () => {
    expect(isListed('scripts/ghosts/launch.ts', GHOSTS_FILES) && isListed('scripts/ghosts/entry.ts', GHOSTS_FILES)).toBe(true)
  })
})

describe('runVerdict', () => {
  interface VerdictBench {
    db: DatabaseSync
    bus: string
    journal: string
    statuses: ReviewStatus[]
    run: (argv: string[], publish?: StatusPublisher, session?: string) => Promise<MergeResult>
  }

  function verdictBench(pr = 42): VerdictBench {
    const root = mkdtempSync(path.join(tmpdir(), 'shift-verdict-'))
    const bus = path.join(root, 'bus.db')
    const journal = path.join(root, 'ghosts.jsonl')
    const db = openBus(bus)
    const gitHub = new FakeGitHub()
    const clock = new Clock()
    gitHub.open({ number: pr })
    new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now).run()
    detectReview({ db, gitHub, clock })
    const statuses: ReviewStatus[] = []
    const posted: StatusPublisher = status => statuses.push(status)
    const gh = (): string => JSON.stringify({ body: busCardBody(pr), headRefOid: sha('a'), files: [{ path: 'scripts/board/derive.ts' }] })
    return { db, bus, journal, statuses, run: (argv, publish = posted, session = 'reviewer-1') => runVerdict(argv, { gh, gitHub: gitHub.client, bus, session, now: clock.now, publish }) }
  }

  function recorded(db: DatabaseSync): Record<string, unknown>[] {
    return db.prepare(`SELECT payload FROM events WHERE type = '${REVIEW_RECORDED}' ORDER BY id`).all().map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
  }

  it('shift:merge --verdict records the verdict in the bus and nothing in the journal', async () => {
    const { db, bus, journal, statuses, run } = verdictBench()
    const result = await run(['42', '--verdict', 'changes', '--commit', sha('a')])
    expect(result).toEqual({ stdout: [`[shift:verdict] #142 PR #42 changes at ${sha('a')} recorded in the bus ${bus}; a chain arms its auto-merge only after a pass at its head, and only at ${sha('a')}`], stderr: [], exitCode: 0 })
    expect(recorded(db)).toMatchObject([{ head: sha('a'), verdict: 'changes', reviewer_session: 'reviewer-1', depth_why: 'the verdict was given by shift:merge --verdict' }])
    expect(recorded(db)[0]).not.toHaveProperty('isolation')
    expect(recorded(db)[0]).not.toHaveProperty('isolationGaps')
    expect(statuses).toEqual([{ commit: sha('a'), state: 'failure', context: 'review', description: 'review verdict changes for card #142 by reviewer-1' }])
    expect(existsSync(journal)).toBe(false)
    db.close()
  })

  it('a pass is posted as a success review status on the reviewed head', async () => {
    const { db, statuses, run } = verdictBench()
    expect((await run(['42', '--verdict', 'pass', '--commit', sha('a')])).exitCode).toBe(0)
    expect(statuses.map(status => status.state)).toEqual(['success'])
    db.close()
  })

  it('records nothing for a commit that is not the head', async () => {
    const { db, statuses, run } = verdictBench()
    const result = await run(['42', '--verdict', 'pass', '--commit', 'f00dfee'])
    expect(result.exitCode).toBe(1)
    expect([recorded(db), statuses]).toEqual([[], []])
    db.close()
  })

  it('refuses naming the bus when the pull request has no review task queued at the head', async () => {
    const { db, bus, run } = verdictBench()
    expect((await run(['42', '--verdict', 'pass', '--commit', sha('a')])).exitCode).toBe(0)
    const again = await run(['42', '--verdict', 'pass', '--commit', sha('a')])
    expect(again).toEqual({ stdout: [], stderr: [`[shift:verdict] PR #42 has no review task queued at ${sha('a')} in the bus ${bus}; nothing recorded`], exitCode: 1 })
    expect(recorded(db)).toHaveLength(1)
    db.close()
  })

  it('a status gh could not post is a denial the bus records, and no verdict', async () => {
    const { db, run } = verdictBench()
    const result = await run(['42', '--verdict', 'pass', '--commit', sha('a')], () => {
      throw new Error('gh: HTTP 403\nmore')
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[shift:verdict\] the bus denied the verdict on PR #42 at [0-9a-f]{40}: github_error \(gh: HTTP 403/)
    expect(recorded(db)).toEqual([])
    db.close()
  })
})

describe('runCarry', () => {
  function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }

  function commit(repo: string, files: Record<string, string>, message: string): string {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), text)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')
  }

  function reviewedPullRequest(own: Record<string, string>): { repo: string, reviewed: string } {
    const repo = mkdtempSync(path.join(tmpdir(), 'shift-merge-carry-'))
    git(repo, 'init', '-q', '-b', 'main')
    commit(repo, { 'shared.txt': 'one\ntwo\nthree\n' }, 'base')
    git(repo, 'checkout', '-q', '-b', 'pr')
    return { repo, reviewed: commit(repo, own, 'own') }
  }

  function mainMoves(repo: string, files: Record<string, string>): void {
    git(repo, 'checkout', '-q', 'main')
    commit(repo, files, 'main moved')
    git(repo, 'checkout', '-q', 'pr')
  }

  function carryRun(repo: string, reviewed: string, head: string, body = cardLine('auto')): { posted: ReviewStatus[], result: ReturnType<typeof runCarry> } {
    const posted: ReviewStatus[] = []
    const journal = prReviewLine({ task: '7', pr: 42, verdict: 'pass', commit: reviewed }, new Date('2026-10-09T03:00:00.000Z'))
    const gh = (): string => JSON.stringify({ body, headRefOid: head, files: [{ path: 'scripts/board/derive.ts' }] })
    const result = runCarry(['42', '--carry'], { gh, git: args => git(repo, ...args), fetch: () => {}, journal: () => journal, main: 'main', publish: status => posted.push(status) })
    return { posted, result }
  }

  it('carries a review success from head A to the head B a clean update-branch merge left', () => {
    const { repo, reviewed } = reviewedPullRequest({ 'own.txt': 'the pull request\n' })
    mainMoves(repo, { 'other.txt': 'main moved\n' })
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const { posted, result } = carryRun(repo, reviewed, head)
    expect(posted).toEqual([{ commit: head, state: 'success', context: 'review', description: `carried from ${reviewed}` }])
    expect(result.exitCode).toBe(0)
  })

  it('carry accepts a body whose first line starts with card: ', () => {
    const { repo, reviewed } = reviewedPullRequest({ 'own.txt': 'the pull request\n' })
    mainMoves(repo, { 'other.txt': 'main moved\n' })
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const { posted, result } = carryRun(repo, reviewed, head, `card: ${cardLine('auto')}\n\nbody`)
    expect(result.stderr).toEqual([])
    expect(posted).toEqual([{ commit: head, state: 'success', context: 'review', description: `carried from ${reviewed}` }])
    expect(result.exitCode).toBe(0)
  })

  it('publishes nothing on B when the update-branch merge resolved a conflict, and says a new review is needed', () => {
    const { repo, reviewed } = reviewedPullRequest({ 'shared.txt': 'one\nTWO from the pull request\nthree\n' })
    mainMoves(repo, { 'shared.txt': 'one\nTWO from main\nthree\n' })
    expect(() => git(repo, 'merge', '-q', '--no-edit', 'main')).toThrow()
    const head = commit(repo, { 'shared.txt': 'one\nTWO resolved\nthree\n' }, 'merge main')
    const { posted, result } = carryRun(repo, reviewed, head)
    expect(posted).toEqual([])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toHaveLength(1)
    expect(result.stderr[0]).toContain(`[shift:carry] PR #42 needs a new review at ${head}`)
    expect(result.stderr[0]).toContain('resolved a conflict')
  })

  it('publishes nothing for a pull request with no review verdict on record', () => {
    const posted: ReviewStatus[] = []
    const gh = (): string => JSON.stringify({ body: cardLine('auto'), headRefOid: HEAD, files: [] })
    const result = runCarry(['42', '--carry'], { gh, git: () => '', fetch: () => {}, journal: () => null, main: 'main', publish: status => posted.push(status) })
    expect([posted, result.exitCode]).toEqual([[], 1])
  })

  describe('runUpdated', () => {
    function updatedRun(repo: string, argv: string[], head: string): { updates: CleanUpdate[], result: MergeResult } {
      const bus = path.join(mkdtempSync(path.join(tmpdir(), 'shift-merge-updated-')), 'bus.db')
      const gh = (): string => JSON.stringify({ body: cardLine('auto'), headRefOid: head, files: [] })
      const result = runUpdated(argv, { gh, git: args => git(repo, ...args), fetch: () => {}, main: 'main', bus, session: 'window-s78', now: () => new Date('2026-10-19T20:00:00.000Z') })
      const db = openBus(bus)
      try {
        return { updates: cleanUpdatesOf(db, 42), result }
      }
      finally {
        db.close()
      }
    }

    it('records a clean update-branch from A to B as a clean update.done the round-limit decision carries across', () => {
      const { repo, reviewed } = reviewedPullRequest({ 'own.txt': 'the pull request\n' })
      mainMoves(repo, { 'other.txt': 'main moved\n' })
      git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main')
      const head = git(repo, 'rev-parse', 'HEAD')
      const { updates, result } = updatedRun(repo, ['42', '--updated', reviewed], head)
      expect(updates).toEqual([{ from: reviewed, to: head }])
      expect(result.exitCode).toBe(0)
    })

    it('records nothing when the update-branch merge resolved a conflict', () => {
      const { repo, reviewed } = reviewedPullRequest({ 'shared.txt': 'one\nTWO from the pull request\nthree\n' })
      mainMoves(repo, { 'shared.txt': 'one\nTWO from main\nthree\n' })
      expect(() => git(repo, 'merge', '-q', '--no-edit', 'main')).toThrow()
      const head = commit(repo, { 'shared.txt': 'one\nTWO resolved\nthree\n' }, 'merge main')
      const { updates, result } = updatedRun(repo, ['42', '--updated', reviewed], head)
      expect(updates).toEqual([])
      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toContain('is not a clean update-branch')
    })

    it('records nothing for a from that is not a full sha, or a head that did not move', () => {
      const { repo, reviewed } = reviewedPullRequest({ 'own.txt': 'the pull request\n' })
      const short = updatedRun(repo, ['42', '--updated', reviewed.slice(0, 8)], reviewed)
      const still = updatedRun(repo, ['42', '--updated', reviewed], reviewed)
      expect([short.updates, short.result.exitCode, still.updates, still.result.exitCode]).toEqual([[], 1, [], 1])
      expect(still.result.stderr[0]).toContain(`is still at ${reviewed}`)
    })
  })
})
