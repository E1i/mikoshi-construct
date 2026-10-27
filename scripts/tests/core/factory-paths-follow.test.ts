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
    const { BUS_RUN_MARKERS } = await import('../../supervisor/bg.js')
    const { REVIEW_WORKER_MARKERS } = await import('../../supervisor/review-bg.js')
    const { SUPERVISOR_LAUNCH } = await import('../../supervisor/supervisor.js')
    const { workerLaunches } = await import('../../supervisor/workers.js')
    const { USAGE } = await import('../../window/window.js')
    const { treePrCommand } = await import('../../nodes/launch/launch-starter.js')
    const { LOOP_SCRIPT } = await import('../../window/exit.js')
    const markers = [BUS_RUN_MARKERS, REVIEW_WORKER_MARKERS, SUPERVISOR_LAUNCH.markers, ...Object.values(workerLaunches(() => [])).map(launch => launch.markers)]
    expect(markers.map(list => list[0]!.startsWith(`${MOVED}/`))).toEqual(markers.map(() => true))
    expect(USAGE).toContain(`${MOVED}/window/window.ts`)
    expect(treePrCommand('/repo')).toContain(`${MOVED}/nodes/launch/tree-pr-cli.ts`)
    expect(LOOP_SCRIPT).toBe(`${MOVED}/window/loop.ts`)
    const { TREE_PR_ENTRY, HEADER_FILE } = await import('../../nodes/launch/launch-worker.js')
    const { BRIEF_FINISH_CLI } = await import('../../ladder/ladder-starter.js')
    const { OWNER_AGENT, OWNER_AGENT_FILE } = await import('../../core/bus-path.js')
    expect(TREE_PR_ENTRY).toBe(`${MOVED}/nodes/launch/tree-pr-cli`)
    expect(HEADER_FILE.endsWith(`${MOVED}/nodes/launch/header.md`)).toBe(true)
    expect(BRIEF_FINISH_CLI).toBe(`${MOVED}/ladder/brief-finish-cli.ts`)
    expect(OWNER_AGENT_FILE).toBe(`${MOVED}/supervisor/launchd/${OWNER_AGENT}.plist`)
  })
})
