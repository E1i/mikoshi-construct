import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { carryLedgerLines } from '../../ghosts/ledger.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')
const LEDGER = path.join('.construct', 'runs.jsonl')
const RUN_SEEDED_ON_MAIN = 'run-old'

const created: string[] = []

function world(...args: string[]): string {
  const result = spawnSync('bash', [WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  if (args[0] === 'new')
    created.push(result.stdout.trim())
  return result.stdout.trim()
}

afterEach(() => {
  while (created.length > 0)
    world('clean', created.pop()!)
})

function runsIn(ledger: string): string[] {
  return readFileSync(ledger, 'utf8').split('\n').filter(line => line !== '').map(line => (JSON.parse(line) as { run: string }).run)
}

function ghostTrees(w: string): string[] {
  return readFileSync(path.join(w, '.world', 'ids'), 'utf8').trim().split(/\s+/).map(id => path.join(w, `wt-${id}`))
}

function launchOk(): { w: string, mainLedger: string, ghostRuns: string[] } {
  const w = world('new', 'ok')
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), LAUNCH, '--tasks', path.join(w, 'tasks.json')], {
    input: 'yes\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(w, 'bin')}:${process.env.PATH}` },
  })
  expect(result.status).toBe(0)
  const mainLedger = path.join(w, 'main', LEDGER)
  const ghostRuns = ghostTrees(w).flatMap(tree => runsIn(path.join(tree, LEDGER))).filter(run => run !== RUN_SEEDED_ON_MAIN)
  expect(ghostRuns.length).toBeGreaterThan(0)
  return { w, mainLedger, ghostRuns }
}

describe('ghosts:launch carries each Ghost ledger line into the main ledger when the run ends', () => {
  it('puts every run a Ghost recorded into the main ledger, once', () => {
    const { mainLedger, ghostRuns } = launchOk()
    const runs = runsIn(mainLedger)
    for (const run of ghostRuns)
      expect(runs.filter(present => present === run), run).toHaveLength(1)
  })

  it('adds no duplicate when the same Ghost ledger is carried again', () => {
    const { w, mainLedger } = launchOk()
    const before = readFileSync(mainLedger, 'utf8')
    for (const tree of ghostTrees(w))
      expect(carryLedgerLines(path.join(tree, LEDGER), mainLedger)).toBe(0)
    expect(readFileSync(mainLedger, 'utf8')).toBe(before)
  })

  it('keeps the line in the main ledger after the Ghost worktree is removed by hand', () => {
    const { w, mainLedger, ghostRuns } = launchOk()
    for (const tree of ghostTrees(w))
      spawnSync('git', ['-C', path.join(w, 'main'), 'worktree', 'remove', '--force', tree], { encoding: 'utf8' })
    for (const tree of ghostTrees(w))
      expect(existsSync(tree), tree).toBe(false)
    const runs = runsIn(mainLedger)
    for (const run of ghostRuns)
      expect(runs, run).toContain(run)
  })
})
