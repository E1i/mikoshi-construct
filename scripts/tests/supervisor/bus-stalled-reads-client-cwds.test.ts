import { describe, expect, it } from 'vitest'
import { OsProcessTable } from '../../ports/process-table.js'
import { clientAdapterOfTheBus } from '../../supervisor/composition.js'
import { busProcessTable } from '../../supervisor/run.js'
import { StalledSessions } from '../../supervisor/stalled-sessions.js'

describe('the bus tick reads the card trees through the client the bus builds', () => {
  it('the table composeBusTick hands to StalledSessions lists the client cwds instead of reporting them unreadable', () => {
    expect(busProcessTable(clientAdapterOfTheBus()).clientCwds()).toMatchObject({ kind: 'listed' })
  })

  it('a table built with no client names no process, which is why the bus never builds one for the undriven sweep', () => {
    expect(new OsProcessTable().clientCwds()).toMatchObject({ kind: 'unreadable' })
  })

  it('stalledSessions cannot be built without the reader of the card trees', () => {
    const parts = { cards: undefined as never, lifeOf: () => 'live' as const }
    // @ts-expect-error trees is a required port, so a caller cannot fall back to a reader that reads nothing
    const build = (): StalledSessions => new StalledSessions(undefined as never, () => new Date(), parts)
    expect(typeof build).toBe('function')
  })
})
