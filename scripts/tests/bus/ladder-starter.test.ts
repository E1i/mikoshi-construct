import type { LadderStep, LadderSteps } from '../../bus/ladder-starter.js'
import type { DetachedSpawn, StarterPorts } from '../../bus/launch-starter.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { LadderCardStarter } from '../../bus/ladder-starter.js'

const CARD = 9401
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function starterFor(step: LadderStep, options: { tree?: string | null, parked?: boolean, unreadableGroup?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ladder-starter-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(parking, 'lane-x'), { recursive: true })
  if (options.parked !== false)
    writeFileSync(path.join(parking, 'lane-x', `${CARD}.md`), parkingFileText({ card: `#${CARD} a-card [implement/netwatch/M/ladder/auto] · depends — · blocks —`, branch: `feat/card-${CARD}`, touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }))
  const spawned: DetachedSpawn[] = []
  const killed: number[] = []
  const cut: string[] = []
  const tree = options.tree === undefined ? '/trees/known' : options.tree
  const ports: StarterPorts = {
    read: file => options.parked === false ? null : readFileSync(file, 'utf8'),
    cut: () => {
      cut.push('cut')
      return '/trees/cut'
    },
    base: () => 'b'.repeat(40),
    spawnDetached: (run) => {
      spawned.push(run)
      return 4242
    },
    pgidOf: () => {
      if (options.unreadableGroup === true)
        throw new Error('ps: no such process')
      return 4242
    },
    kill: target => killed.push(target),
    uuid: () => 'sess-1',
    envOf: () => ({}),
    prompt: task => task.body,
  }
  const steps: LadderSteps = {
    stepOf: () => step,
    tree: () => tree,
    brief: () => '/handoff/brief.md',
    tasksFile: () => '/handoff/tasks.json',
    body: (_task, kind) => `body of the ${kind} step`,
  }
  const starter = new LadderCardStarter({ parking, launchDir: path.join(root, 'launch'), claude: 'claude', treePr: 'tree-pr', repo: '/repo' }, ports, steps)
  return { starter, spawned, killed, cut, parking }
}

describe('the brief chain', () => {
  it('runs brief-finish before ghosts:hash --by morse', () => {
    const { starter, spawned } = starterFor({ kind: 'brief' }, { tree: null })
    starter.start({ cardId: CARD, lane: 'lane-x' })

    const script = spawned[0]!.args[1]!
    const claude = script.indexOf('env claude')
    const finish = script.indexOf('brief-finish-cli.ts')
    const hash = script.indexOf(`'ghosts:hash'`)
    expect(claude).toBeGreaterThanOrEqual(0)
    expect(finish).toBeGreaterThan(claude)
    expect(hash).toBeGreaterThan(finish)
    expect(script).toContain(`'/trees/cut' '/handoff/brief.md' && pnpm`)
  })
})

describe('the ladder starter chains', () => {
  it('the brief chain cuts the tree, runs the claude session, then MORSE, then ghosts:launch with a yes', () => {
    const { starter, spawned, cut, parking } = starterFor({ kind: 'brief' }, { tree: null })
    const start = starter.start({ cardId: CARD, lane: 'lane-x' })

    expect(start).toMatchObject({ kind: 'started', card: { session: 'sess-1', worktree: '/trees/cut', pid: 4242, pgid: 4242, step: 'brief' } })
    expect(cut).toEqual(['cut'])
    const run = spawned[0]!
    expect(run.cwd).toBe('/trees/cut')
    expect(run.args.slice(2)).toEqual(['shift', '-p', '--session-id', 'sess-1'])
    const script = run.args[1]!
    expect(script).toBe(`env claude --permission-mode dontAsk "$@" && pnpm --dir '/repo' --silent exec tsx 'scripts/shift/brief-finish-cli.ts' '${parking}/lane-x/${CARD}.md' '/trees/cut' '/handoff/brief.md' && pnpm --dir '/repo' --silent 'ghosts:hash' '/handoff/brief.md' '--by' 'morse' '--card' '${CARD}' '--parking' '${parking}' && printf 'yes\\n' | pnpm --dir '/repo' --silent 'ghosts:launch' '--tasks' '/handoff/tasks.json'`)
    expect(run.input).toContain('body of the brief step')
  })

  it('the launch chain only launches the Ghost in the known tree and never cuts', () => {
    const { starter, spawned, cut } = starterFor({ kind: 'launch' })
    const start = starter.start({ cardId: CARD, lane: 'lane-x' })

    expect(start).toMatchObject({ kind: 'started', card: { worktree: '/trees/known', step: 'launch' } })
    expect(cut).toEqual([])
    expect(spawned[0]!.args[1]).toBe(`printf 'yes\\n' | pnpm --dir '/repo' --silent 'ghosts:launch' '--tasks' '/handoff/tasks.json'`)
    expect(spawned[0]!.input).toBe('')
    expect(spawned[0]!.args.slice(2)).toEqual(['shift', '-p', '--session-id', 'sess-1'])
  })

  it('the review chain runs the claude session in the known tree and opens the pull request', () => {
    const { starter, spawned } = starterFor({ kind: 'review' })
    const start = starter.start({ cardId: CARD, lane: 'lane-x' })

    expect(start).toMatchObject({ kind: 'started', card: { worktree: '/trees/known', step: 'review' } })
    const script = spawned[0]!.args[1]!
    expect(script.startsWith('env claude --permission-mode dontAsk "$@" && tree-pr ')).toBe(true)
    expect(script).toContain(`'/trees/known'`)
    expect(spawned[0]!.input).toContain('body of the review step')
  })

  it('a launch or review step with no tree is refused and spawns nothing', () => {
    for (const kind of ['launch', 'review'] as const) {
      const { starter, spawned } = starterFor({ kind }, { tree: null })

      expect(starter.start({ cardId: CARD, lane: 'lane-x' })).toMatchObject({ kind: 'refused', denial: { reason: 'start_failed' } })
      expect(spawned).toEqual([])
    }
  })

  it('a running Ghost and a faulted ladder are refused with their own reason and spawn nothing', () => {
    const running = starterFor({ kind: 'running' })
    const fault = starterFor({ kind: 'fault', why: 'the Ghost ended with ladder status fault' })

    expect(running.starter.start({ cardId: CARD, lane: 'lane-x' })).toMatchObject({ kind: 'refused', denial: { reason: 'ladder_running' } })
    expect(fault.starter.start({ cardId: CARD, lane: 'lane-x' })).toMatchObject({ kind: 'refused', denial: { reason: 'ladder_fault', detail: 'the Ghost ended with ladder status fault' } })
    expect([...running.spawned, ...fault.spawned]).toEqual([])
  })

  it('a card file that is not there is refused as unreadable', () => {
    const { starter } = starterFor({ kind: 'brief' }, { parked: false })

    expect(starter.start({ cardId: CARD, lane: 'lane-x' })).toMatchObject({ kind: 'refused', denial: { reason: 'card_unreadable' } })
  })

  it('a process group that cannot be read kills the chain before start_failed', () => {
    const { starter, killed } = starterFor({ kind: 'launch' }, { unreadableGroup: true })

    expect(starter.start({ cardId: CARD, lane: 'lane-x' })).toMatchObject({ kind: 'refused', denial: { reason: 'start_failed' } })
    expect(killed).toEqual([4242])
  })

  it('stop signals the whole group of a group leader', () => {
    const { starter, killed } = starterFor({ kind: 'launch' })
    starter.stop({ session: 's', worktree: '/t', branch: 'b', base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'ladder' })

    expect(killed).toEqual([-4242])
  })
})
