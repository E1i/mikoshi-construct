import type { DatabaseSync } from 'node:sqlite'
import type { Poll } from '../../ports/netwatch.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { PR_OBSERVED } from '../../core/events.js'
import { PR_FOLDS } from '../../core/reducer.js'
import { NetWatch } from '../../ports/netwatch.js'
import { BusTick } from '../../supervisor/run.js'
import { Clock, FakeGitHub } from '../bus/github-fake.js'

const PR = 52
const HEAD = 'b'.repeat(40)

class NetWatchThatTicks extends NetWatch {
  override poll(): Poll {
    return { kind: 'ticked', reason: 'interval', calls: 0, remaining: null, written: 0, unsettled: [] }
  }
}

const buses: DatabaseSync[] = []

afterEach(() => {
  for (const bus of buses.splice(0))
    bus.close()
})

function prObservedBy(db: DatabaseSync, clock: Clock): () => void {
  return () => {
    appendEvent(db, { ts: clock.now().toISOString(), type: PR_OBSERVED, actor: 'netwatch', cardId: null, pr: PR, head: HEAD, dedupeKey: `${PR_OBSERVED}:${PR}:${HEAD}`, payload: { base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
  }
}

describe('the bus tick folds with the projection list it was given', () => {
  it('an event the window requests append between the two reduces is folded by the second reduce with the given list', () => {
    const db = openBus(':memory:')
    buses.push(db)
    const clock = new Clock()
    const tick = new BusTick(db, { folds: [PR_FOLDS], incremental: [] }, new NetWatchThatTicks(db, new FakeGitHub().client, clock.now), clock.now, () => {}, () => {}, prObservedBy(db, clock))
    expect(tick.run()?.reduced).toEqual({ applied: 1, rejected: 0 })
    expect(db.prepare('SELECT pr, head FROM prs').all().map(row => ({ ...row }))).toEqual([{ pr: PR, head: HEAD }])
  })
})
