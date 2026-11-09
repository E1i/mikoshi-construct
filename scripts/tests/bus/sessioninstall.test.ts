import type { Answerer } from '../../nodes/answer/answerer.js'
import type { DetachedSpawn } from '../../nodes/launch/launch-starter.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { realStarterPorts } from '../../nodes/launch/launch-root.js'
import { lacksItsPackages, PREPARE_TREE, prepareTree } from '../../ports/prepare-tree.js'
import { sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const CARD = 1440
const LOCKFILE = 'pnpm-lock.yaml'

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bus-sessioninstall-'))
  roots.push(dir)
  return dir
}

function treeIn(dir: string, locked: boolean): string {
  const tree = path.join(dir, `mc-${CARD}`)
  mkdirSync(tree)
  if (locked)
    writeFileSync(path.join(tree, LOCKFILE), 'lockfileVersion: 9.0\n')
  return tree
}

function sessionSpawn(tree: string, dir: string): DetachedSpawn {
  return { command: 'true', args: [], cwd: tree, env: { PATH: process.env.PATH }, input: '', log: path.join(dir, 'launch', `log-${CARD}.txt`) }
}

describe('the launch worker', () => {
  it('the launch worker prepares the tree before the card session starts', () => {
    const dir = root()
    const tree = treeIn(dir, true)
    const spawn = sessionSpawn(tree, dir)
    const prepared: Array<{ tree: string, sessionLogged: boolean }> = []
    const ports = realStarterPorts(dir, {}, '', () => 'u', () => null, () => [], null, path.join(dir, 'bus.db'), each => prepared.push({ tree: each, sessionLogged: existsSync(spawn.log) }))

    ports.spawnDetached(spawn)

    expect(prepared).toEqual([{ tree, sessionLogged: false }])
    expect(existsSync(spawn.log)).toBe(true)
  })

  it('a card session still starts when the install fails, and the worker says why', () => {
    const dir = root()
    const tree = treeIn(dir, true)
    const spawn = sessionSpawn(tree, dir)
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ports = realStarterPorts(dir, {}, '', () => 'u', () => null, () => [], null, path.join(dir, 'bus.db'), () => {
      throw new Error('ERR_PNPM_OUTDATED_LOCKFILE')
    })

    ports.spawnDetached(spawn)

    expect(existsSync(spawn.log)).toBe(true)
    expect(said).toHaveBeenCalledWith(expect.stringContaining('ERR_PNPM_OUTDATED_LOCKFILE'))
    expect(said).toHaveBeenCalledWith(expect.stringContaining(PREPARE_TREE.join(' ')))
  })

  function lockedTree(dir: string): string {
    const tree = treeIn(dir, true)
    writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ name: 'a-tree', dependencies: { citty: '^0.1.0' }, devDependencies: { vitest: '^1.0.0' } }))
    mkdirSync(path.join(tree, 'node_modules'))
    writeFileSync(path.join(tree, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n')
    return tree
  }

  function installed(tree: string, name: string): void {
    mkdirSync(path.join(tree, 'node_modules', name), { recursive: true })
    writeFileSync(path.join(tree, 'node_modules', name, 'package.json'), `{"name":"${name}"}`)
  }

  function preparedArgs(tree: string): (readonly string[])[] {
    const runs: (readonly string[])[] = []
    prepareTree(tree, (_tree, args) => runs.push(args))
    return runs
  }

  it('a tree whose modules state survived and whose packages are gone is prepared with --force', () => {
    const tree = lockedTree(root())
    installed(tree, 'citty')
    symlinkSync(path.join(tree, 'node_modules', '.pnpm', 'vitest@1.0.0', 'node_modules', 'vitest'), path.join(tree, 'node_modules', 'vitest'))

    expect(lacksItsPackages(tree)).toBe(true)
    expect(preparedArgs(tree)).toEqual([[...PREPARE_TREE.slice(1), '--force']])
  })

  it('a tree whose packages are present is prepared with the plain frozen install', () => {
    const tree = lockedTree(root())
    installed(tree, 'citty')
    installed(tree, 'vitest')

    expect(lacksItsPackages(tree)).toBe(false)
    expect(preparedArgs(tree)).toEqual([PREPARE_TREE.slice(1)])
  })

  it('a tree with no lockfile is not prepared', () => {
    const dir = root()
    const tree = treeIn(dir, false)
    const prepared: string[] = []
    const ports = realStarterPorts(dir, {}, '', () => 'u', () => null, () => [], null, path.join(dir, 'bus.db'), each => prepared.push(each))

    ports.spawnDetached(sessionSpawn(tree, dir))

    expect(prepared).toEqual([])
  })
})

function answeringCard(prepare: (tree: string) => void, order: string[]): { made: MergeBench, executor: AnswerExecutor, tree: string } {
  const made = mergeBench()
  benches.push(made)
  const dir = root()
  const tree = treeIn(dir, true)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: tree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}` }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  const cardTrees: CardTreeTools = { home: dir, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const answerer: Answerer = async () => {
    order.push('session')
    return { session: 'answer-session-1', resumed: true, before: sha('a'), after: sha('b'), owner: null }
  }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null, prepare })
  return { made, executor, tree }
}

describe('the answer executor', () => {
  it('the answer executor prepares the tree before the answer session', async () => {
    const order: string[] = []
    const card = answeringCard(tree => order.push(`prepare ${tree}`), order)

    const outcome = await card.executor.answer(leaseNext(card.made.db, card.made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!)

    expect(outcome).toMatchObject({ kind: 'answered' })
    expect(order).toEqual([`prepare ${card.tree}`, 'session'])
  })

  it('a lockfile the install refuses still reaches the answer session, which rebuilds it', async () => {
    const order: string[] = []
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const card = answeringCard(() => {
      order.push('prepare')
      throw new Error('ERR_PNPM_LOCKFILE_BREAKING_CHANGE')
    }, order)

    const outcome = await card.executor.answer(leaseNext(card.made.db, card.made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!)

    expect(outcome).toMatchObject({ kind: 'answered' })
    expect(order).toEqual(['prepare', 'session'])
    expect(said).toHaveBeenCalledWith(expect.stringContaining('ERR_PNPM_LOCKFILE_BREAKING_CHANGE'))
  })
})
