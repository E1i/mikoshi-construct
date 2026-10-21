import type { BgResult, DetachedLaunch, RunningProcess } from '../../bus/bg.js'
import type { BusCode } from '../../bus/supervisor.js'
import { describe, expect, it } from 'vitest'
import { launchName } from '../../bus/bg.js'
import { reviewLaunch } from '../../bus/review-bg.js'
import { BusSupervisor, LOCAL_MAIN_REF } from '../../bus/supervisor.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)

describe('the supervisor follows the local main ref', () => {
  it('a moved local main ref restarts the bus with no GitHub call', async () => {
    let checkout = OLD_MAIN
    const review = reviewLaunch(() => [])
    let alive: RunningProcess[] = [{ pid: 600, args: `node pnpm.cjs --silent ${launchName(review)}` }]
    const started: string[] = []
    const stopped: number[] = []
    const mainAdvancedReads: number[] = []
    const code: BusCode = {
      head: () => checkout,
      holds: sha => sha === checkout,
      pull: () => {
        throw new Error('the checkout already holds the local main; no pull is needed')
      },
      busChangedSince: sha => sha !== checkout,
      localMain: () => checkout,
    }
    const supervisor = new BusSupervisor({
      known: [review],
      wanted: () => [review],
      start: (launch: DetachedLaunch): BgResult => {
        started.push(launchName(launch))
        alive = [...alive, { pid: 700, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
        return { stdout: [], stderr: [], exitCode: 0 }
      },
      stop: async (instance) => {
        stopped.push(instance.pid)
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      processes: () => alive,
      mainSince: (afterId) => {
        mainAdvancedReads.push(afterId)
        return []
      },
      code,
      journal: () => {},
      now: () => 0,
    }, 0)

    expect(await supervisor.step()).toEqual([])
    expect(supervisor.ownCodeBehind).toBeNull()

    checkout = NEW_MAIN
    const lines = await supervisor.step()

    expect(lines.join('\n')).toContain(`the local ${LOCAL_MAIN_REF} moved to ${NEW_MAIN} with no main.advanced on the bus`)
    expect(lines.join('\n')).toContain(`restarting every running bus process on ${NEW_MAIN}`)
    expect(stopped).toEqual([600])
    expect(started).toEqual([launchName(review)])
    expect(supervisor.ownCodeBehind).toBe(NEW_MAIN)
    expect(mainAdvancedReads).toEqual([0, 0])

    expect(await supervisor.step()).toEqual([])
    expect(started).toEqual([launchName(review)])
  })

  it('a local main ref that cannot be read leaves the supervisor on main.advanced alone', async () => {
    const review = reviewLaunch(() => [])
    const supervisor = new BusSupervisor({
      known: [review],
      wanted: () => [review],
      start: () => ({ stdout: [], stderr: [], exitCode: 0 }),
      stop: async () => {},
      processes: () => [],
      mainSince: () => [],
      code: { head: () => OLD_MAIN, holds: () => true, pull: () => {}, busChangedSince: () => true, localMain: () => null },
      journal: () => {},
      now: () => 0,
    }, 0)

    expect(await supervisor.step()).toEqual([])
    expect(supervisor.ownCodeBehind).toBeNull()
  })
})
