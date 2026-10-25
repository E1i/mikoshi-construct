import { afterEach, describe, expect, it, vi } from 'vitest'

const MOVED = 'scripts/moved'

afterEach(() => {
  vi.doUnmock('../../core/factory-paths.js')
  vi.resetModules()
})

describe('a path moved in the factory registry', () => {
  it('the spawners and markers follow a path moved in the registry', async () => {
    vi.resetModules()
    vi.doMock('../../core/factory-paths.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../core/factory-paths.js')>()
      const moved = <T extends Record<string, string>>(paths: T) => Object.fromEntries(Object.entries(paths).map(([id, file]) => [id, file.replace('scripts/', `${MOVED}/`)])) as T
      return { ...real, FACTORY_RUNTIME: moved(real.FACTORY_RUNTIME), FACTORY_WORKERS: moved(real.FACTORY_WORKERS), FACTORY_NAMED: moved(real.FACTORY_NAMED) }
    })
    const { BUS_RUN_MARKERS } = await import('../../bus/bg.js')
    const { REVIEW_WORKER_MARKERS } = await import('../../bus/review-bg.js')
    const { SUPERVISOR_LAUNCH } = await import('../../bus/supervisor.js')
    const { workerLaunches } = await import('../../bus/workers.js')
    const { USAGE } = await import('../../bus/window.js')
    const { treePrCommand } = await import('../../bus/launch-starter.js')
    const { LOOP_SCRIPT } = await import('../../miko/exit.js')
    const markers = [BUS_RUN_MARKERS, REVIEW_WORKER_MARKERS, SUPERVISOR_LAUNCH.markers, ...Object.values(workerLaunches(() => [])).map(launch => launch.markers)]
    expect(markers.map(list => list[0]!.startsWith(`${MOVED}/bus/`))).toEqual(markers.map(() => true))
    expect(USAGE).toContain(`${MOVED}/bus/window.ts`)
    expect(treePrCommand('/repo')).toContain(`${MOVED}/shift/tree-pr-cli.ts`)
    expect(LOOP_SCRIPT).toBe(`${MOVED}/miko/loop.ts`)
    const { TREE_PR_ENTRY, HEADER_FILE } = await import('../../bus/launch-worker.js')
    const { BRIEF_FINISH_CLI } = await import('../../bus/ladder-starter.js')
    const { OWNER_AGENT, OWNER_AGENT_FILE } = await import('../../bus/start.js')
    expect(TREE_PR_ENTRY).toBe(`${MOVED}/shift/tree-pr-cli`)
    expect(HEADER_FILE.endsWith(`${MOVED}/shift/header.md`)).toBe(true)
    expect(BRIEF_FINISH_CLI).toBe(`${MOVED}/shift/brief-finish-cli.ts`)
    expect(OWNER_AGENT_FILE).toBe(`${MOVED}/bus/launchd/${OWNER_AGENT}.plist`)
  })
})
