import type { RunnerTask, RunnerTestFile } from 'vitest'
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SCENARIO_9_FILE = '../prepush-timeout-relaunches-on-its-tree.test.ts'
const THIS_FILE = 'acceptance.test.ts'
const RAN_STATES = ['pass', 'fail']

const SUITES: Record<string, () => Promise<unknown>> = {
  'k1-process-identity.test.ts': async () => import('./k1-process-identity.test.js'),
  'k1a-generation-handed.test.ts': async () => import('./k1a-generation-handed.test.js'),
  'k1a-process-records.test.ts': async () => import('./k1a-process-records.test.js'),
  'k2-signal-sent.test.ts': async () => import('./k2-signal-sent.test.js'),
  'k3-handover-predicate.test.ts': async () => import('./k3-handover-predicate.test.js'),
  'k4-release-carries-tree.test.ts': async () => import('./k4-release-carries-tree.test.js'),
  'k6-session-carries-over.test.ts': async () => import('./k6-session-carries-over.test.js'),
  'k7-lease-follows-executor.test.ts': async () => import('./k7-lease-follows-executor.test.js'),
  'o1-record-paths.test.ts': async () => import('./o1-record-paths.test.js'),
  'o2-groups-and-order.test.ts': async () => import('./o2-groups-and-order.test.js'),
  'o3-turn-drives-update-merge.test.ts': async () => import('./o3-turn-drives-update-merge.test.js'),
  'o4-decision-supersedes-tasks.test.ts': async () => import('./o4-decision-supersedes-tasks.test.js'),
  'r-events.test.ts': async () => import('./r-events.test.js'),
  'r-lint.test.ts': async () => import('./r-lint.test.js'),
  'r-paths.test.ts': async () => import('./r-paths.test.js'),
  'r0-declarations.test.ts': async () => import('./r0-declarations.test.js'),
  'scenario-waiters-die-with-their-run.test.ts': async () => import('./scenario-waiters-die-with-their-run.test.js'),
  [SCENARIO_9_FILE]: async () => import('../prepush-timeout-relaunches-on-its-tree.test.js'),
}

interface ScenarioTest {
  file: string
  title: string
}

const SCENARIO_TESTS: Record<number, ScenarioTest[]> = {
  1: [{ file: 'o3-turn-drives-update-merge.test.ts', title: 'scenario 01:' }],
  2: [{ file: 'o3-turn-drives-update-merge.test.ts', title: 'scenario 02:' }],
  3: [
    { file: 'k1-process-identity.test.ts', title: 'scenario 03 (K1)' },
    { file: 'k3-handover-predicate.test.ts', title: 'scenario 03:' },
  ],
  4: [
    { file: 'k2-signal-sent.test.ts', title: 'scenario 04: a session SIGKILLed from outside the bus' },
    { file: 'k4-release-carries-tree.test.ts', title: 'scenario 04: a session SIGKILLed after its local main merge' },
  ],
  5: [{ file: 'o4-decision-supersedes-tasks.test.ts', title: 'scenario 05:' }],
  6: [
    { file: 'r-events.test.ts', title: 'scenario 06:' },
    { file: 'r-paths.test.ts', title: 'scenario 06:' },
  ],
  7: [{ file: 'k3-handover-predicate.test.ts', title: 'scenario 07:' }],
  8: [{ file: 'k6-session-carries-over.test.ts', title: 'scenario 08:' }],
  9: [{ file: SCENARIO_9_FILE, title: 'queues its launch task again on the tree as it stands' }],
  10: [
    { file: 'o2-groups-and-order.test.ts', title: 'scenario 10:' },
    { file: 'o3-turn-drives-update-merge.test.ts', title: 'scenario 10:' },
    { file: 'r-paths.test.ts', title: 'scenario 10:' },
  ],
  11: [{ file: 'o3-turn-drives-update-merge.test.ts', title: 'scenario 11:' }],
  12: [{ file: 'k7-lease-follows-executor.test.ts', title: 'scenario 12:' }],
  13: [{ file: 'k3-handover-predicate.test.ts', title: 'scenario 13:' }],
  14: [
    { file: 'o2-groups-and-order.test.ts', title: 'scenario 14:' },
    { file: 'o3-turn-drives-update-merge.test.ts', title: 'scenario 14:' },
    { file: 'r-events.test.ts', title: 'scenario 14:' },
  ],
  15: [
    { file: 'o3-turn-drives-update-merge.test.ts', title: 'scenario 15:' },
    { file: 'r0-declarations.test.ts', title: 'scenario 15, the validator part' },
  ],
  17: [{ file: 'k3-handover-predicate.test.ts', title: 'scenario 17:' }],
}

const CORE_SCENARIOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]
const AFTER_CHECKPOINT_SCENARIOS = [16]

const D535_ACCEPTANCE = [
  { item: 'incident: needs_update chase, PR #1609/#1616/#1611', scenario: 1 },
  { item: 'incident: update late 4.5 min, 12641193/12641196', scenario: 2 },
  { item: 'incident: answers cut by restart, #1852 ×5, #1901', scenario: 3 },
  { item: 'incident: update refused, tree off head, 12647900', scenario: 4 },
  { item: 'incident: D-532 recorded, card did not move, 12639599', scenario: 5 },
  { item: 'incident: Q351–Q354 shared-file stops', scenario: 6 },
  { item: 'incident: load deferral + restart, #1852 10:35–11:35Z', scenario: 7 },
  { item: 'incident: fresh session every round, #1852', scenario: 8 },
  { item: 'incident: #1749 no PR after a prepush timeout, 09:51:45Z', scenario: 9 },
  { item: 'independent cards advance in parallel', scenario: 10 },
  { item: 'a real conflict is caught', scenario: 11 },
]

function testsUnder(task: RunnerTask): RunnerTask[] {
  if (task.type === 'test')
    return [task]
  return task.tasks.flatMap(testsUnder)
}

function suiteOf(file: RunnerTestFile, name: string): RunnerTask | undefined {
  return file.tasks.find(task => task.type === 'suite' && task.name === name)
}

for (const [name, load] of Object.entries(SUITES)) {
  describe(name, async () => {
    await load()
  })
}

describe('conveyor acceptance (D-535, project slice Z)', () => {
  it('runs every scenario test file under scripts/tests/bus/conveyor/, and the scenario 9 file beside it', () => {
    const onDisk = readdirSync(import.meta.dirname).filter(file => file.endsWith('.test.ts') && file !== THIS_FILE)
    expect(Object.keys(SUITES).filter(file => file !== SCENARIO_9_FILE).sort()).toEqual(onDisk.sort())
  })

  it('names a scenario test for every core scenario, and none for a scenario after its checkpoint', () => {
    expect(Object.keys(SCENARIO_TESTS).map(Number)).toEqual(CORE_SCENARIOS)
    for (const scenario of AFTER_CHECKPOINT_SCENARIOS)
      expect(SCENARIO_TESTS[scenario]).toBeUndefined()
  })

  it('holds the nine incidents, the parallel cards and the caught conflict, each on a core scenario', () => {
    expect(D535_ACCEPTANCE.filter(member => member.item.startsWith('incident:'))).toHaveLength(9)
    expect(new Set(D535_ACCEPTANCE.map(member => member.scenario)).size).toBe(D535_ACCEPTANCE.length)
    for (const member of D535_ACCEPTANCE)
      expect(CORE_SCENARIOS, member.item).toContain(member.scenario)
  })

  it('finds the test of each D-535 member and of every core scenario run in this run, none skipped', ({ task }) => {
    const file = task.file
    for (const scenario of CORE_SCENARIOS) {
      const members = D535_ACCEPTANCE.filter(member => member.scenario === scenario).map(member => member.item)
      for (const { file: name, title } of SCENARIO_TESTS[scenario]!) {
        const suite = suiteOf(file, name)
        const label = `scenario ${scenario} ${members.join(', ')} — ${name}: ${title}`
        expect(suite, label).toBeDefined()
        const matching = testsUnder(suite!).filter(test => test.fullName.includes(title))
        expect(matching.length, label).toBeGreaterThan(0)
        for (const test of matching) {
          expect(test.mode, `${label} — ${test.fullName}`).toBe('run')
          expect(RAN_STATES, `${label} — ${test.fullName}`).toContain(test.result?.state)
        }
      }
    }
  })
})
