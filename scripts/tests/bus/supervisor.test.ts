import type { BgResult, DetachedLaunch, RunningProcess } from '../../supervisor/bg.js'
import type { BusCode } from '../../supervisor/supervisor.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchName } from '../../supervisor/bg.js'
import { reviewLaunch } from '../../supervisor/review-bg.js'
import { BusSupervisor, entryOf, gitCode, importClosure, LOCAL_MAIN_REF, SUPERVISOR_LAUNCH } from '../../supervisor/supervisor.js'
import { busLaunches, workerLaunches } from '../../supervisor/workers.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'

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
      changedSince: sha => sha === checkout ? [] : [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
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
      code: { head: () => OLD_MAIN, holds: () => true, pull: () => {}, changedSince: () => [SHARED_FILE], runs: () => new Set([SHARED_FILE]), localMain: () => null },
      journal: () => {},
      now: () => 0,
    }, 0)

    expect(await supervisor.step()).toEqual([])
    expect(supervisor.ownCodeBehind).toBeNull()
  })
})

describe('the code a bus process runs', () => {
  const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
  const code = gitCode(repoRoot)
  const runsOf = (launch: DetachedLaunch): ReadonlySet<string> => code.runs(entryOf(launch)!)

  it('every launch the supervisor knows, and the supervisor itself, names an entry its checkout holds', () => {
    for (const launch of [...busLaunches(() => []), SUPERVISOR_LAUNCH])
      expect(runsOf(launch).has(entryOf(launch)!)).toBe(true)
  })

  it('the shared bus code is in the code of every node, and one node\'s worker is not in another\'s', () => {
    const { answer, close } = workerLaunches(() => [])
    for (const launch of [...busLaunches(() => []), SUPERVISOR_LAUNCH]) {
      for (const shared of ['scripts/core/db.ts', 'scripts/core/node.ts', 'scripts/core/lease.ts', 'scripts/core/queue.ts', 'scripts/core/reducer.ts'])
        expect(runsOf(launch)).toContain(shared)
    }
    for (const launch of Object.values(workerLaunches(() => [])))
      expect(runsOf(launch)).toContain('scripts/core/node.ts')
    expect(runsOf(close)).not.toContain(entryOf(answer))
    expect(runsOf(answer)).not.toContain(entryOf(close))
  })

  it('an import closure follows import, export-from and side-effect imports across lines and directories', () => {
    const files: Record<string, string> = {
      'a/entry.ts': `import type { T } from './types.js'\nimport {\n  b,\n} from './b.js'\nexport * from '../c/c.js'\nimport './side.js'\nimport fs from 'node:fs'\n`,
      'a/types.ts': '',
      'a/b.ts': `export const b = 'from here'\n`,
      'c/c.ts': `import data from './data.json'\n`,
      'c/data.json': '{}',
      'a/side.ts': '',
      'a/unreached.ts': '',
    }
    expect([...importClosure('a/entry.ts', file => files[file] ?? null)].sort()).toEqual(['a/b.ts', 'a/entry.ts', 'a/side.ts', 'a/types.ts', 'c/c.ts', 'c/data.json'])
  })
})
