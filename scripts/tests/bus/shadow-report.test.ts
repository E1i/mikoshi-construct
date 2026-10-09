import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { EXIT_CRITERIA, PREFIX, shadowReport } from '../../bus/report.js'
import { BusTick } from '../../bus/run.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('shadow report', () => {
  it('the shadow report prints every §9 exit criterion', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-shadow-report-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const gitHub = new FakeGitHub()
    const clock = new Clock()
    const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now)
    const tick = (): void => {
      busTick.run()
      clock.advance(TICK_MS)
    }
    gitHub.open({ number: 930 })
    gitHub.open({ number: 931 })
    gitHub.open({ number: 932 })
    tick()
    gitHub.open({ number: 930, head: sha('b') })
    gitHub.close(931, true)
    tick()
    gitHub.close(932, false)
    tick()
    db.prepare(`INSERT INTO events (ts, type, actor, pr, dedupe_key, payload) VALUES (?, 'pr.closed', 'netwatch', 999, 'pr:999:closed', '{"merged":true}')`).run(clock.now().toISOString())
    tick()

    const lines = shadowReport(db, gitHub.client, '', () => clock.ms)
    for (const line of lines)
      expect(line.startsWith(PREFIX)).toBe(true)
    for (const criterion of Object.values(EXIT_CRITERIA))
      expect(lines.some(line => line.startsWith(`${PREFIX}${criterion}: `)), criterion).toBe(true)
    const text = lines.join('\n')
    expect(text).toContain('over the whole log: 4 ticks, 0 skipped polls')
    expect(text).toContain(`${EXIT_CRITERIA.prs}: 3 of 3 agree (open 1, merged 1, closed 1); transitions seen: merged 2, closed 1; mismatched: none; open on GitHub, missing here: none`)
    expect(text).toContain(`${EXIT_CRITERIA.latency}: 4 heads queued, median 1 ticks, max 1 ticks; green with no verdict and not queued: none`)
    expect(text).toContain(`${EXIT_CRITERIA.superseded}: 1 superseded; still queued on an old head: none`)
    expect(text).toContain(`${EXIT_CRITERIA.lag}: max 0 ticks over 3 ticks that wrote events; not reduced yet: 0`)
    expect(text).toContain(`${EXIT_CRITERIA.rejected}: 1 (pr.closed 1)`)
    expect(text).toMatch(new RegExp(`${EXIT_CRITERIA.replay}: none, \\d+ bytes identical`))
    db.close()
  })
})
