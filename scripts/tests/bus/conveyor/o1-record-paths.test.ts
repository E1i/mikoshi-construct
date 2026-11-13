import type { GitHub } from '../../../ports/github.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../../core/db.js'
import { EVENT_PAYLOADS, MAIN_ADVANCED, PR_OBSERVED } from '../../../core/events.js'
import { NetWatch, TICK_MS } from '../../../ports/netwatch.js'
import { MAIN_FILES_CAP, PULL_FILES_PAGE, PULL_FILES_PAGES } from '../../../ports/snapshot.js'
import { Clock, FakeGitHub, MAIN_1, MAIN_2, MAIN_3, REPO, sha } from '../github-fake.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

type Bus = ReturnType<typeof openBus>

function setUp(client?: (gitHub: FakeGitHub) => GitHub): { db: Bus, gitHub: FakeGitHub, clock: Clock, netWatch: NetWatch, tick: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-o1-paths-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const netWatch = new NetWatch(db, client === undefined ? gitHub.client : client(gitHub), clock.now)
  netWatch.poll()
  return { db, gitHub, clock, netWatch, tick: () => {
    clock.advance(TICK_MS)
    netWatch.poll()
  } }
}

function payloads(db: Bus, type: string): Record<string, unknown>[] {
  return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
}

const EVENT_CONSUMERS = [
  'scripts/core/bus-readings.ts',
  'scripts/core/queue.ts',
  'scripts/core/reducer.ts',
  'scripts/core/report.ts',
  'scripts/nodes/answer/answer-source.ts',
  'scripts/nodes/answer/answer-worker.ts',
  'scripts/nodes/answer/duties/publishing.ts',
  'scripts/nodes/launch/launch-candidates.ts',
  'scripts/nodes/launch/launch-worker.ts',
  'scripts/nodes/merge/merge-worker.ts',
  'scripts/nodes/review/review-worker.ts',
  'scripts/nodes/update/update-worker.ts',
  'scripts/nodes/witness/witness-worker.ts',
  'scripts/policy/round-limit-decision.ts',
  'scripts/supervisor/stalled-sessions.ts',
  'scripts/supervisor/supervisor.ts',
  'scripts/window/board.ts',
  'scripts/window/operator-work.ts',
  'scripts/window/requests/context.ts',
  'scripts/window/requests/reach.ts',
  'scripts/window/watch.ts',
]

const filesOf = (pr: number): RegExp => new RegExp(`^repos/\\{owner\\}/\\{repo\\}/pulls/${pr}/files\\?`)

describe('conveyor O1: the bus records the paths a pull request and main changed', () => {
  it('pr.observed carries the paths of pulls/N/files, fetched once per new head and not on every tick', () => {
    const { db, gitHub, tick } = setUp((fake) => {
      fake.open({ number: 920, files: ['scripts/core/events.ts', 'docs/index.md'] })
      return fake.client
    })
    expect(gitHub.calls.filter(call => filesOf(920).test(call))).toEqual([`${REPO}/pulls/920/files?per_page=${PULL_FILES_PAGE}&page=1`])
    expect(payloads(db, PR_OBSERVED)).toEqual([expect.objectContaining({ head: sha('a'), paths: ['scripts/core/events.ts', 'docs/index.md'], pathsTruncated: false })])

    gitHub.calls = []
    gitHub.open({ number: 920, mergeable_state: 'behind', files: ['scripts/core/events.ts', 'docs/index.md'] })
    tick()
    tick()
    expect(gitHub.calls.filter(call => filesOf(920).test(call))).toEqual([])
    expect(payloads(db, PR_OBSERVED).map(payload => [payload.mergeable, payload.paths])).toEqual([
      ['clean', ['scripts/core/events.ts', 'docs/index.md']],
      ['behind', ['scripts/core/events.ts', 'docs/index.md']],
    ])

    gitHub.open({ number: 920, head: sha('b'), files: ['scripts/ports/snapshot.ts'] })
    tick()
    expect(gitHub.calls.filter(call => filesOf(920).test(call))).toHaveLength(1)
    expect(payloads(db, PR_OBSERVED).at(-1)).toMatchObject({ head: sha('b'), paths: ['scripts/ports/snapshot.ts'], pathsTruncated: false })
    db.close()
  })

  it('a pull request whose every page of files is full records pathsTruncated', () => {
    const fullPage = (page: string): { filename: string }[] => Array.from({ length: PULL_FILES_PAGE }, (_, index) => ({ filename: `src/p${page}/f${index}.ts` }))
    const { db, gitHub } = setUp((fake) => {
      fake.open({ number: 921 })
      return (endpoint) => {
        const page = /^repos\/\{owner\}\/\{repo\}\/pulls\/921\/files\?per_page=\d+&page=(\d+)$/.exec(endpoint)
        if (page === null)
          return fake.client(endpoint)
        fake.calls.push(endpoint)
        return { status: 200, headers: {}, body: fullPage(page[1]!) }
      }
    })
    expect(gitHub.calls.filter(call => filesOf(921).test(call))).toHaveLength(PULL_FILES_PAGES)
    const [observed] = payloads(db, PR_OBSERVED)
    expect(observed).toMatchObject({ pathsTruncated: true })
    expect(observed!.paths).toHaveLength(PULL_FILES_PAGE * PULL_FILES_PAGES)
    db.close()
  })

  it('main.advanced carries the paths snapshot already fetched beside touches_mechanics, with no new GitHub call', () => {
    const many = Array.from({ length: MAIN_FILES_CAP }, (_, index) => `docs/page-${index}.md`)
    const { db, gitHub, tick } = setUp((fake) => {
      fake.mainFiles = { [MAIN_1]: ['README.md'], [MAIN_2]: ['scripts/ladder/ladder.ts'], [MAIN_3]: many }
      return fake.client
    })
    gitHub.main = MAIN_2
    gitHub.calls = []
    tick()
    expect(gitHub.calls).toEqual([`${REPO}/pulls?state=open&per_page=100`, `${REPO}/commits/main`, `${REPO}/compare/${MAIN_1}...${MAIN_2}`])
    gitHub.main = MAIN_3
    tick()
    expect(payloads(db, MAIN_ADVANCED)).toEqual([
      { sha: MAIN_1, touches_mechanics: false, paths: ['README.md'], pathsTruncated: false },
      { sha: MAIN_2, touches_mechanics: true, paths: ['scripts/ladder/ladder.ts'], pathsTruncated: false },
      { sha: MAIN_3, touches_mechanics: false, paths: many, pathsTruncated: true },
    ])
    db.close()
  })

  it('the catalogue EVENT_PAYLOADS declares paths and pathsTruncated on both events', () => {
    expect(EVENT_PAYLOADS[PR_OBSERVED]).toEqual(expect.arrayContaining(['paths', 'pathsTruncated']))
    expect(EVENT_PAYLOADS[MAIN_ADVANCED]).toEqual(expect.arrayContaining(['paths', 'pathsTruncated', 'touches_mechanics']))
  })

  it('nothing reads the recorded paths: no consumer of pr.observed or main.advanced names pathsTruncated', () => {
    const naming = EVENT_CONSUMERS.filter(file => readFileSync(file, 'utf8').includes('pathsTruncated'))
    expect(naming).toEqual([])
  })
})
