import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { parseIncluded } from '../../bus/github.js'
import { NetWatch, TICK_MS, WAKE_GAP_MS } from '../../bus/netwatch.js'
import { reduce } from '../../bus/reducer.js'
import { touchesMechanics } from '../../bus/snapshot.js'
import { Clock, FakeGitHub, MAIN_1, MAIN_2, MAIN_3, REPO, sha } from './github-fake.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setUp(): { db: ReturnType<typeof openBus>, gitHub: FakeGitHub, clock: Clock, netWatch: NetWatch } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-netwatch-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  return { db, gitHub, clock, netWatch: new NetWatch(db, gitHub.client, clock.now) }
}

function events(db: ReturnType<typeof openBus>, type: string): { pr: number | null, card_id: number | null, head: string | null, dedupe_key: string, payload: Record<string, unknown> }[] {
  return db.prepare('SELECT pr, card_id, head, dedupe_key, payload FROM events WHERE type = ? ORDER BY id').all(type).map(row => ({
    pr: row.pr as number | null,
    card_id: row.card_id as number | null,
    head: row.head as string | null,
    dedupe_key: String(row.dedupe_key),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
  }))
}

describe('netwatch', () => {
  it('an unchanged pr gives no second pr.observed', () => {
    const { db, gitHub, clock, netWatch } = setUp()
    gitHub.open({ number: 900, review: 'success' })
    expect(netWatch.poll()).toMatchObject({ kind: 'ticked', reason: 'start' })
    clock.advance(TICK_MS)
    expect(netWatch.poll()).toMatchObject({ kind: 'ticked', reason: 'interval', written: 0 })
    const observed = events(db, 'pr.observed')
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ pr: 900, card_id: 1000, head: sha('a') })
    expect(observed[0]!.payload).toEqual({ base: 'main', head: sha('a'), mergeable: 'clean', ci: 'green', verdict_on_head: 'pass', auto_merge: false, draft: false })
    expect(observed[0]!.dedupe_key).toMatch(/^pr:900:[0-9a-f]{64}:-$/)

    gitHub.open({ number: 900, mergeable_state: 'behind', review: 'success' })
    clock.advance(TICK_MS)
    netWatch.poll()
    expect(events(db, 'pr.observed').map(event => event.payload.mergeable)).toEqual(['clean', 'behind'])
    db.close()
  })

  // eslint-disable-next-line test/prefer-lowercase-title -- the witness of card #795 names this test with a capital A, and vitest -t matches case-sensitively
  it('A then B then A on the same head gives three events and the projection ends on A, a repeated tick gives one', () => {
    const { db, gitHub, clock, netWatch } = setUp()
    const tick = (): void => {
      clock.advance(TICK_MS)
      netWatch.poll()
    }
    gitHub.open({ number: 911 })
    netWatch.poll()
    tick()
    gitHub.open({ number: 911, mergeable_state: 'behind' })
    tick()
    tick()
    gitHub.open({ number: 911 })
    tick()
    tick()

    const observed = events(db, 'pr.observed')
    expect(observed.map(event => [event.head, event.payload.mergeable])).toEqual([[sha('a'), 'clean'], [sha('a'), 'behind'], [sha('a'), 'clean']])
    const ids = db.prepare(`SELECT id FROM events WHERE type = 'pr.observed' ORDER BY id`).all().map(row => Number(row.id))
    expect(observed.map(event => event.dedupe_key.split(':').at(-1))).toEqual(['-', String(ids[0]), String(ids[1])])
    reduce(db)
    expect(db.prepare('SELECT head, mergeable FROM prs WHERE pr = 911').get()).toEqual({ head: sha('a'), mergeable: 'clean' })
    db.close()
  })

  it('a known pr missing from the open list is fetched and observed as pr.closed', () => {
    const { db, gitHub, clock, netWatch } = setUp()
    gitHub.open({ number: 901 })
    netWatch.poll()
    gitHub.pulls.set(901, { ...gitHub.pulls.get(901)!, state: 'closed', merged: true, merge_commit_sha: MAIN_2 })
    clock.advance(TICK_MS)
    gitHub.calls = []
    netWatch.poll()
    expect(gitHub.calls).toContain(`${REPO}/pulls/901`)
    expect(events(db, 'pr.closed')).toEqual([{ pr: 901, card_id: 1001, head: null, dedupe_key: 'pr:901:closed', payload: { merged: true, commit: MAIN_2 } }])

    clock.advance(TICK_MS)
    gitHub.calls = []
    netWatch.poll()
    expect(gitHub.calls).not.toContain(`${REPO}/pulls/901`)
    expect(events(db, 'pr.closed')).toHaveLength(1)
    db.close()
  })

  it('a missed tick is caught up on the next tick from the snapshot', () => {
    const { db, gitHub, clock, netWatch } = setUp()
    gitHub.open({ number: 902, required: 'pending' })
    gitHub.open({ number: 903 })
    gitHub.mainFiles = { [MAIN_1]: ['README.md'], [MAIN_2]: ['scripts/shift/shift.ts'], [MAIN_3]: ['docs/index.md'] }
    netWatch.poll()

    gitHub.failing = true
    clock.advance(TICK_MS)
    expect(netWatch.poll()).toMatchObject({ kind: 'skipped', cause: 'failed' })

    gitHub.failing = false
    gitHub.open({ number: 902, head: sha('b'), required: 'success' })
    gitHub.pulls.set(903, { ...gitHub.pulls.get(903)!, state: 'closed', merged: true, merge_commit_sha: MAIN_3 })
    gitHub.main = MAIN_3
    clock.advance(TICK_MS)
    expect(netWatch.poll()).toMatchObject({ kind: 'ticked', reason: 'interval' })

    expect(events(db, 'pr.observed').filter(event => event.pr === 902).map(event => [event.head, event.payload.ci])).toEqual([[sha('a'), 'pending'], [sha('b'), 'green']])
    expect(events(db, 'pr.closed').map(event => event.pr)).toEqual([903])
    expect(events(db, 'main.advanced').map(event => [event.dedupe_key, event.payload])).toEqual([
      [`main:${MAIN_1}`, { sha: MAIN_1, touches_mechanics: false }],
      [`main:${MAIN_3}`, { sha: MAIN_3, touches_mechanics: true }],
    ])
    expect(events(db, 'netwatch.skipped')).toHaveLength(1)
    db.close()
  })

  it('each tick records its rate-limit spend', () => {
    const { db, gitHub, clock, netWatch } = setUp()
    gitHub.open({ number: 904 })
    gitHub.open({ number: 905 })
    const first = netWatch.poll()
    expect(first).toMatchObject({ kind: 'ticked', calls: gitHub.calls.length, remaining: 5000 - gitHub.calls.length })
    expect(gitHub.calls).toHaveLength(1 + 2 * 3 + 1)
    clock.advance(TICK_MS)
    netWatch.poll()
    const ticks = events(db, 'netwatch.tick')
    expect(ticks.map(tick => tick.payload.calls)).toEqual([8, 8])
    expect(ticks.map(tick => tick.payload.rate_remaining)).toEqual([4992, 4984])
    db.close()
  })

  it('a 403 or 429 waits for Retry-After and records the skipped poll', () => {
    for (const status of [403, 429]) {
      const { db, gitHub, clock, netWatch } = setUp()
      gitHub.open({ number: 906 })
      gitHub.limited = { status, headers: { 'retry-after': '150', 'x-ratelimit-remaining': '0' }, body: { message: 'rate limit' } }
      expect(netWatch.poll()).toMatchObject({ kind: 'skipped', cause: 'rate-limited', calls: 1, until: '2026-10-09T12:02:30.000Z' })

      gitHub.limited = null
      gitHub.calls = []
      clock.advance(TICK_MS)
      expect(netWatch.poll()).toMatchObject({ kind: 'skipped', cause: 'retry-after', calls: 0 })
      clock.advance(TICK_MS)
      expect(netWatch.poll()).toMatchObject({ kind: 'skipped', cause: 'retry-after' })
      expect(gitHub.calls).toEqual([])

      clock.advance(TICK_MS)
      expect(netWatch.poll()).toMatchObject({ kind: 'ticked' })
      expect(events(db, 'netwatch.skipped').map(event => event.payload.cause)).toEqual(['rate-limited', 'retry-after', 'retry-after'])
      expect(events(db, 'pr.observed').map(event => event.pr)).toEqual([906])
      db.close()
    }
  })

  it('after a wake the next tick is an immediate full reconciliation', () => {
    const { db, gitHub, clock, netWatch } = setUp()
    gitHub.open({ number: 907 })
    gitHub.open({ number: 908 })
    netWatch.poll()
    clock.advance(TICK_MS / 2)
    expect(netWatch.poll()).toBeNull()

    gitHub.pulls.set(907, { ...gitHub.pulls.get(907)!, state: 'closed', merged: false })
    gitHub.open({ number: 908, head: sha('c') })
    gitHub.open({ number: 909 })
    gitHub.main = MAIN_2
    clock.advance(WAKE_GAP_MS + TICK_MS)
    expect(netWatch.poll()).toMatchObject({ kind: 'ticked', reason: 'wake' })
    expect(events(db, 'pr.closed').map(event => [event.pr, event.payload])).toEqual([[907, { merged: false }]])
    expect(events(db, 'pr.observed').map(event => [event.pr, event.head])).toEqual([[907, sha('a')], [908, sha('a')], [908, sha('c')], [909, sha('a')]])
    expect(events(db, 'main.advanced').map(event => event.payload.sha)).toEqual([MAIN_1, MAIN_2])
    expect(events(db, 'netwatch.tick').at(-1)!.payload).toMatchObject({ reason: 'wake', gap_s: (TICK_MS / 2 + WAKE_GAP_MS + TICK_MS) / 1000 })
    db.close()
  })

  it('a pr whose mergeable state GitHub has not computed yet is observed on a later tick', () => {
    const { db, gitHub, clock, netWatch } = setUp()
    gitHub.open({ number: 910, mergeable_state: 'unknown' })
    expect(netWatch.poll()).toMatchObject({ kind: 'ticked', unsettled: [910] })
    expect(events(db, 'pr.observed')).toEqual([])
    gitHub.open({ number: 910, mergeable_state: 'dirty' })
    clock.advance(TICK_MS)
    netWatch.poll()
    expect(events(db, 'pr.observed').map(event => event.payload.mergeable)).toEqual(['dirty'])
    db.close()
  })

  it('main touches the mechanics when a changed path is one the chains run', () => {
    expect(touchesMechanics(['scripts/shift/shift.ts'])).toBe(true)
    expect(touchesMechanics(['.claude/agents/review.md'])).toBe(true)
    expect(touchesMechanics(['package.json'])).toBe(true)
    expect(touchesMechanics(['src/program.ts', 'docs/package.json'])).toBe(false)
  })

  it('reads the status, the headers and the body that gh api --include prints', () => {
    expect(parseIncluded('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 30\r\nX-Ratelimit-Remaining: 0\r\n\r\n{"message":"slow down"}\n')).toEqual({
      status: 429,
      headers: { 'retry-after': '30', 'x-ratelimit-remaining': '0' },
      body: { message: 'slow down' },
    })
  })
})
