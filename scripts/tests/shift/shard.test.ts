import type { World } from './fixtures/autopilot-world.js'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runShard } from '../../shift/shard.js'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, depsOf, eventsOf, fakeGh, lines, newWorld, stubRuns } from './fixtures/autopilot-world.js'

const OWNER = 'implement/runner/S/cheap/owner'
const MANIFEST = path.resolve(import.meta.dirname, '../../../construct.json')
const SHARD = '5a4d0000-0000-4000-8000-000000000650'
const HEAD = 'a1b2c3d'

interface Pr {
  branch?: string
  checks?: { name: string, status: string, conclusion: string }[] | 'fails'
}

function initWorld(body: string): World {
  const world = newWorld([{ id: 1, kind: OWNER, body }])
  copyFileSync(MANIFEST, path.join(world.repo, 'construct.json'))
  return world
}

function ownerGh(pr: Pr = {}): { gh: (args: string[]) => string, calls: string[][] } {
  const inner = fakeGh({ 101: cardLine(1, OWNER) })
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    if (args[1] === 'view' && args.at(-1) === 'headRefName,headRefOid')
      return JSON.stringify({ headRefName: pr.branch ?? 'feat/1', headRefOid: HEAD })
    if (args[1] === 'view' && args.at(-1) === 'headRefOid,statusCheckRollup,files') {
      if (pr.checks === 'fails')
        throw new Error('gh: HTTP 502')
      return JSON.stringify({ headRefOid: HEAD, statusCheckRollup: pr.checks ?? [{ name: 'required', status: 'IN_PROGRESS', conclusion: '' }], files: [] })
    }
    return inner.gh(args)
  }
  return { gh, calls }
}

function issue(world: World): string {
  const io = captured()
  expect(runShard([world.shift, '--by', 'Eli'], { cwd: world.repo, handoffDir: world.handoff, append: (file, text) => writeFileSync(file, text, { flag: 'a' }), now: () => new Date('2026-10-08T09:00:00.000Z'), uuid: () => SHARD, by: () => '', out: line => io.out.push(line), err: line => io.err.push(line) })).toBe(0)
  return SHARD
}

function merges(calls: string[][]): string[][] {
  return calls.filter(args => args[1] === 'merge')
}

async function shift(world: World, gh: (args: string[]) => string, slot?: string): Promise<{ code: number, io: ReturnType<typeof captured> }> {
  const io = captured()
  const code = await runShift([world.shift, '--parking', world.parking, ...(slot === undefined ? [] : ['--slot', slot])], depsOf(world, gh, io))
  return { code, io }
}

describe('a shard delegates one owner merge to one shift run', () => {
  it('pnpm shard writes one shard line naming who, when and the run', () => {
    const world = initWorld('do 1')
    issue(world)
    expect(eventsOf(world, 'shard')).toEqual([{ event: 'shard', id: SHARD, by: 'Eli', ts: '2026-10-08T09:00:00.000Z', run: world.shift }])
  })

  it('without a shard an owner PR stops at the owner', async () => {
    const world = initWorld('do 1 STUB-VERIFIED-run STUB-PR-101')
    issue(world)
    const { gh, calls } = ownerGh()
    await shift(world, gh)
    expect(merges(calls)).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101 }])
    expect(eventsOf(world, 'delegated')).toEqual([])
    expect(eventsOf(world, 'shard-used')).toEqual([])
  })

  it('with a shard an owner PR is armed and journals the delegation', async () => {
    const world = initWorld('do 1 STUB-VERIFIED-run STUB-PR-101')
    const shard = issue(world)
    const { gh, calls } = ownerGh()
    const { code } = await shift(world, gh, shard)
    expect(code).toBe(0)
    expect(merges(calls)).toEqual([['pr', 'merge', '101', '--auto', '--squash', '--match-head-commit', HEAD, '-R', 'E1i/mikoshi-construct']])
    expect(eventsOf(world, 'delegated')).toMatchObject([{ task: '1', pr: 101, shard, why: `owner decision delegated, shard ${shard}` }])
    expect(eventsOf(world, 'stop')).toEqual([])
    const journal = lines(world.journal).map(line => line.event)
    expect(journal.indexOf('shard-used')).toBeLessThan(journal.indexOf('path'))
    expect(eventsOf(world, 'shard-used')).toMatchObject([{ id: shard, run: world.shift }])
  })

  it('a question with a shard stops', async () => {
    const world = initWorld('do 1 STUB-QUESTION STUB-VERIFIED-run STUB-PR-101')
    const shard = issue(world)
    const { gh, calls } = ownerGh()
    await shift(world, gh, shard)
    expect(merges(calls)).toEqual([])
    expect(eventsOf(world, 'delegated')).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'question' }])
  })

  it('a guard refusal with a shard stops', async () => {
    const world = initWorld('do 1 STUB-REFUSED STUB-VERIFIED-run STUB-PR-101')
    const shard = issue(world)
    const { gh, calls } = ownerGh()
    await shift(world, gh, shard)
    expect(merges(calls)).toEqual([])
    expect(eventsOf(world, 'delegated')).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault', why: 'guard refusal' }])
  })

  it('red required checks with a shard stop at merge', async () => {
    const world = initWorld('do 1 STUB-VERIFIED-run STUB-PR-101')
    const shard = issue(world)
    const { gh, calls } = ownerGh({ checks: [{ name: 'required', status: 'COMPLETED', conclusion: 'FAILURE' }] })
    await shift(world, gh, shard)
    expect(merges(calls)).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', why: expect.stringContaining('required checks red') as unknown }])
  })

  it('unknown required checks with a shard stop at merge', async () => {
    const world = initWorld('do 1 STUB-VERIFIED-run STUB-PR-101')
    const shard = issue(world)
    const { gh, calls } = ownerGh({ checks: 'fails' })
    await shift(world, gh, shard)
    expect(merges(calls)).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', why: expect.stringContaining('required checks UNKNOWN') as unknown }])
  })

  it('a used shard is refused', async () => {
    const world = initWorld('do 1 STUB-VERIFIED-run STUB-PR-101')
    const shard = issue(world)
    const { gh } = ownerGh()
    await shift(world, gh, shard)
    const again = await shift(world, gh, shard)
    expect(again.code).toBe(1)
    expect(again.io.err.join('\n')).toContain(`shard ${shard} was used once already`)
    expect(eventsOf(world, 'shard-used')).toHaveLength(1)
    expect(stubRuns(world, 1)).toBe(1)
  })

  it('attach with a shard is refused', async () => {
    const world = initWorld('do 1 STUB-VERIFIED-run STUB-PR-101')
    mkdirSync(path.join(world.repo, '.construct'))
    writeFileSync(path.join(world.repo, '.construct', 'attach.json'), '{}\n')
    const shard = issue(world)
    const { gh, calls } = ownerGh()
    const { code, io } = await shift(world, gh, shard)
    expect(code).toBe(1)
    expect(io.err.join('\n')).toContain('.construct/attach.json exists')
    expect(eventsOf(world, 'shard-used')).toEqual([])
    expect(stubRuns(world, 1)).toBe(0)
    expect(merges(calls)).toEqual([])
  })

  it('a version PR with a shard stays the owner', async () => {
    const world = initWorld('do 1 STUB-VERIFIED-run STUB-PR-101')
    const shard = issue(world)
    const { gh, calls } = ownerGh({ branch: 'changeset-release/main' })
    await shift(world, gh, shard)
    expect(merges(calls)).toEqual([])
    expect(eventsOf(world, 'delegated')).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', why: expect.stringContaining('is a version pull request (changeset-release/main) and stays the owner\'s') as unknown }])
  })
})
