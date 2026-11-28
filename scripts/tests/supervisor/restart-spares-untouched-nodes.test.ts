import type { BgResult, DetachedLaunch, RunningProcess } from '../../supervisor/bg.js'
import type { BusCode } from '../../supervisor/supervisor.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FACTORY_WORKERS } from '../../core/factory-paths.js'
import { launchName } from '../../supervisor/bg.js'
import { reviewLaunch } from '../../supervisor/composition.js'
import { BusSupervisor, gitCode } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const TYPE_ONLY_MODULE = 'scripts/core/shape-of-a-row.ts'
const VALUE_MODULE = 'scripts/core/value-of-a-row.ts'
const BARREL_MODULE = 'scripts/core/row-barrel.ts'
const ANSWER_PID = 4100
const MERGE_PID = 4200

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function checkoutWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'restart-spares-'))
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function importFrom(entry: string, module: string): string {
  return `./${path.posix.relative(path.posix.dirname(entry), module).replace(/\.ts$/, '.js')}`
}

const answerSource = [
  `import type { Row } from '${importFrom(FACTORY_WORKERS.answer, TYPE_ONLY_MODULE)}'`,
  `import { valueOf } from '${importFrom(FACTORY_WORKERS.answer, VALUE_MODULE)}'`,
  'export const answered = (row: Row): string => valueOf(row)',
].join('\n')

const mergeSource = [
  'import type {',
  '  Row,',
  `} from '${importFrom(FACTORY_WORKERS.merge, TYPE_ONLY_MODULE)}'`,
  'export const merged = (row: Row): Row => row',
].join('\n')

const barrelAnswerSource = `import { valueOf } from '${importFrom(FACTORY_WORKERS.answer, BARREL_MODULE)}'\nexport const answered = (id: number): string => valueOf({ id })\n`

const barrelSource = [
  'export type Row = { id: number }',
  `export { valueOf } from '${importFrom(BARREL_MODULE, VALUE_MODULE)}'`,
  '',
].join('\n')

function advanceTouching(changed: string, answerEntry: string = answerSource): { supervisor: BusSupervisor, stopped: number[], started: string[], advance: () => void } {
  const root = checkoutWith({
    [FACTORY_WORKERS.answer]: answerEntry,
    [FACTORY_WORKERS.merge]: mergeSource,
    [TYPE_ONLY_MODULE]: 'export interface Row { id: number }\n',
    [VALUE_MODULE]: 'export const valueOf = (row: { id: number }): string => String(row.id)\n',
    [BARREL_MODULE]: barrelSource,
  })
  const { answer, merge } = workerLaunches(reviewLaunch(() => []))
  const nodes: DetachedLaunch[] = [answer!, merge!]
  let checkout = OLD_MAIN
  let alive: RunningProcess[] = [
    { pid: ANSWER_PID, args: `node /x/dist/${FACTORY_WORKERS.answer.replace(/\.ts$/, '.js')} --on` },
    { pid: MERGE_PID, args: `node /x/dist/${FACTORY_WORKERS.merge.replace(/\.ts$/, '.js')} --on` },
  ]
  const stopped: number[] = []
  const started: string[] = []
  const code: BusCode = {
    head: () => checkout,
    holds: sha => sha === checkout,
    pull: () => {},
    changedSince: sha => sha === checkout ? [] : [changed],
    runs: gitCode(root).runs,
    localMain: () => checkout,
  }
  const supervisor = new BusSupervisor({
    known: nodes,
    wanted: () => nodes,
    start: (launch: DetachedLaunch): BgResult => {
      started.push(launchName(launch))
      return { stdout: [], stderr: [], exitCode: 0 }
    },
    stop: async (instance) => {
      stopped.push(instance.pid)
      alive = alive.filter(candidate => candidate.pid !== instance.pid)
    },
    processes: () => alive,
    mainSince: () => [],
    code,
    journal: () => {},
    now: () => 0,
  }, 0)
  const advance = (): void => {
    checkout = NEW_MAIN
  }
  return { supervisor, stopped, started, advance }
}

describe('a main advance restarts only the nodes whose running code it changed', () => {
  it('an advance that changes a module the nodes import only as types restarts no node, because the built entry they run holds no such import', async () => {
    const { supervisor, stopped, started, advance } = advanceTouching(TYPE_ONLY_MODULE)
    expect(await supervisor.step()).toEqual([])
    advance()

    const lines = await supervisor.step()

    expect(lines.join('\n')).toContain(`main advanced to ${NEW_MAIN} with no change to the code a bus process runs; nothing restarted`)
    expect(stopped).toEqual([])
    expect(started).toEqual([])
    expect(supervisor.ownCodeBehind).toBeNull()
  })

  it('an advance that changes a module one node imports as a value restarts that node and spares the other', async () => {
    const { supervisor, stopped, started, advance } = advanceTouching(VALUE_MODULE)
    expect(await supervisor.step()).toEqual([])
    advance()

    const lines = await supervisor.step()

    const { answer } = workerLaunches(reviewLaunch(() => []))
    expect(lines.join('\n')).toContain(`a change to the code of ${answer!.script}; restarting only those on ${NEW_MAIN}`)
    expect(stopped).toEqual([ANSWER_PID])
    expect(started).toEqual([launchName(answer!)])
  })

  it('a type alias followed by a value re-export keeps the re-export in the closure, so a change to the re-exported module restarts the node that imports the barrel', async () => {
    const { supervisor, stopped, started, advance } = advanceTouching(VALUE_MODULE, barrelAnswerSource)
    expect(await supervisor.step()).toEqual([])
    advance()

    await supervisor.step()

    const { answer } = workerLaunches(reviewLaunch(() => []))
    expect(stopped).toEqual([ANSWER_PID])
    expect(started).toEqual([launchName(answer!)])
  })
})
