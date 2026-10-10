import type { CardStart, CardStarter, LaunchOutcome, QueuedCard } from '../../bus/launch-executor.js'
import type { StarterPorts } from '../../bus/launch-starter.js'
import type { Lease } from '../../bus/lease.js'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { CARD_ADMITTED, CARD_STARTED } from '../../bus/launch-candidates.js'
import { LaunchExecutor } from '../../bus/launch-executor.js'
import { psPgid, ShiftCardStarter, spawnDetached } from '../../bus/launch-starter.js'
import { LaunchWorker } from '../../bus/launch-worker.js'
import { leaseNext } from '../../bus/lease.js'
import { blockFor } from '../../bus/update-worker.js'
import { busLaunches } from '../../bus/workers.js'
import { OPERATOR_CLAUDE } from '../../shift/relaunch.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

const roots: string[] = []
const groups: number[] = []

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const launch = (cardId: number): string => taskKey({ queue: 'launch', cardId })

class FakeStarter implements CardStarter {
  starts: QueuedCard[] = []
  constructor(private readonly answer: (card: QueuedCard) => CardStart = card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } })) {}
  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return this.answer(card)
  }
}

function launchBench(starter: CardStarter = new FakeStarter()) {
  const bench = mergeBench()
  const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now })
  const ts = (): string => bench.clock.now().toISOString()
  return {
    ...bench,
    admit: (cardId: number, lane: string, depends: number[] = []): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends }, legacy: false })
    },
    started: (cardId: number): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: 'earlier' }, legacy: false })
    },
    mergedPr: (pr: number): void => {
      bench.gitHub.open({ number: pr })
      bench.tick()
      bench.gitHub.close(pr, true)
      bench.tick()
    },
    leaseLaunch: (actor = 'worker:launch:worker-1'): Lease | null => leaseNext(bench.db, ts(), 'launch', actor),
    launch: (lease: Lease): LaunchOutcome => executor.launch(lease),
  }
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-launch-'))
  roots.push(root)
  return root
}

function stubClaude(root: string): { command: string, argsFile: string } {
  const argsFile = path.join(root, 'claude-args.txt')
  const command = path.join(root, 'claude-stub.sh')
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$*" "card=$CONSTRUCT_CARD" > '${argsFile}'\ncat > /dev/null\nexec sleep 30\n`)
  chmodSync(command, 0o755)
  return { command, argsFile }
}

function waitFor(file: string): string {
  for (let attempt = 0; attempt < 100 && !existsSync(file); attempt += 1)
    blockFor(50)
  return readFileSync(file, 'utf8')
}

function realStarter(root: string, shiftClaude: string | undefined, cardId: number): ShiftCardStarter {
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(parking, 'lane-x'), { recursive: true })
  writeFileSync(path.join(parking, 'lane-x', `${cardId}.md`), parkingFileText({ card: `#${cardId} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }))
  const worktree = path.join(root, `mc-${cardId}`)
  mkdirSync(worktree)
  const env: NodeJS.ProcessEnv = { ...process.env, SHIFT_CLAUDE: shiftClaude }
  if (shiftClaude === undefined)
    delete env.SHIFT_CLAUDE
  const ports: StarterPorts = {
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    cut: () => worktree,
    base: () => 'b'.repeat(40),
    spawnDetached: (run) => {
      const pid = spawnDetached(run)
      groups.push(pid)
      return pid
    },
    pgidOf: psPgid,
    uuid: () => `session-${cardId}`,
  }
  return new ShiftCardStarter({ parking, launchDir: path.join(root, 'launch'), header: 'card {{card}} in {{worktree}}, report {{report}}\n\n', env }, ports)
}

describe('the launch queue', () => {
  it('a queued card whose depends are merged and whose lane is free enters launch', () => {
    const bench = launchBench()
    bench.mergedPr(800)
    bench.admit(901, 'lane-a', [900])
    bench.admit(902, 'lane-b')
    bench.tick()

    expect(taskState(bench.db, launch(901))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(taskState(bench.db, launch(902))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(bench.leaseLaunch()).toMatchObject({ taskKey: launch(901), queue: 'launch', cardId: 901, pr: null, head: null, leaseGen: 1 })
    bench.close()
  })

  it('a card with an unmerged depends or a busy lane does not enter launch', () => {
    const bench = launchBench()
    bench.gitHub.open({ number: 810 })
    bench.admit(910, 'lane-a')
    bench.started(910)
    bench.admit(911, 'lane-a')
    bench.admit(912, 'lane-b', [910])
    bench.admit(913, 'lane-c')
    bench.admit(914, 'lane-c')
    bench.tick()

    expect(taskState(bench.db, launch(911))).toBeUndefined()
    expect(taskState(bench.db, launch(912))).toBeUndefined()
    expect(taskState(bench.db, launch(913))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(914))).toBeUndefined()

    bench.gitHub.close(810, true)
    bench.tick()
    expect(taskState(bench.db, launch(911))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(912))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a launch is spawned detached as its own process group leader and records card.started', () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const bench = launchBench(realStarter(root, stub.command, 920))
    bench.admit(920, 'lane-x')
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)
    expect(outcome.kind).toBe('started')
    const card = (outcome as Extract<LaunchOutcome, { kind: 'started' }>).card
    waitFor(stub.argsFile)
    expect(card.pid).not.toBe(process.pid)
    expect(psPgid(card.pid)).toBe(card.pid)
    expect(card.pgid).toBe(card.pid)
    expect(psPgid(card.pid)).not.toBe(psPgid(process.pid))
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([{ session: 'session-920', worktree: path.join(root, 'mc-920'), branch: 'feat/card-920', base: 'b'.repeat(40), pid: card.pid, pgid: card.pid }])
    expect(taskState(bench.db, launch(920))).toMatchObject({ state: 'completed' })
    bench.tick()
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })

  it('a process that is not its own group leader is denied and records no card.started', () => {
    const bench = launchBench(new FakeStarter(card => ({ kind: 'started', card: { session: 's', worktree: '/t', branch: 'b', base: 'f'.repeat(40), pid: 5000 + card.cardId, pgid: 1 } })))
    bench.admit(925, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'denied', denial: { reason: 'not_detached' }, next: 'queued' })
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([])
    bench.close()
  })

  it('a launch starts the card in the shift mode, not the mode it inherited', () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const bench = launchBench(realStarter(root, `${stub.command} --permission-mode auto`, 930))
    bench.admit(930, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!).kind).toBe('started')
    const [args, card] = waitFor(stub.argsFile).trim().split('\n')
    expect(args).toMatch(/^--permission-mode auto -p --session-id session-930$/)
    expect(OPERATOR_CLAUDE).toContain('dontAsk')
    expect(args).not.toContain('dontAsk')
    expect(card).toBe('card=930')
    bench.close()

    const unset = launchBench(realStarter(tempRoot(), undefined, 931))
    unset.admit(931, 'lane-x')
    unset.tick()
    expect(unset.launch(unset.leaseLaunch()!)).toMatchObject({ kind: 'denied', denial: { reason: 'no_shift_mode' } })
    expect(eventsOf(unset.db, CARD_STARTED)).toEqual([])
    unset.close()
  })

  it('a launch with a stale lease_gen is refused and writes nothing', () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    bench.admit(940, 'lane-a')
    bench.tick()
    const lease = bench.leaseLaunch()!
    const stale: Lease = { ...lease, leaseGen: lease.leaseGen - 1 }
    const before = eventCount(bench.db)

    expect(bench.launch(stale)).toEqual({ kind: 'fenced', taskKey: launch(940) })
    expect(eventCount(bench.db)).toBe(before)
    expect(starter.starts).toEqual([])
    bench.close()
  })

  it('a card started by someone else while the launch ran is refused at complete', () => {
    const bench = launchBench()
    const starter = new FakeStarter((card) => {
      bench.started(card.cardId)
      return { kind: 'started', card: { session: 's', worktree: '/t', branch: 'b', base: 'f'.repeat(40), pid: 7, pgid: 7 } }
    })
    const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now })
    bench.admit(945, 'lane-a')
    bench.tick()

    expect(executor.launch(bench.leaseLaunch()!)).toEqual({ kind: 'fenced', taskKey: launch(945) })
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([{ session: 'earlier' }])
    expect(taskState(bench.db, launch(945))).toMatchObject({ state: 'leased' })
    bench.close()
  })

  it('a card that is no longer queued when leased is withdrawn without a start', () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    bench.admit(950, 'lane-a')
    bench.tick()
    const lease = bench.leaseLaunch()!
    bench.started(950)

    expect(bench.launch(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'card_not_queued' }, next: 'withdrawn' })
    expect(starter.starts).toEqual([])
    bench.close()
  })

  it('the launch worker takes the launch queue and ships switched off in bus:bg', () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    bench.admit(960, 'lane-a')
    bench.tick()
    const worker = new LaunchWorker({ db: bench.db, starter, clock: bench.clock.now, session: 'w1' })

    expect(worker.step()).toMatchObject({ kind: 'started', taskKey: launch(960) })
    expect(worker.step()).toEqual({ kind: 'idle' })
    expect(busLaunches(() => []).map(each => [each.script, ...each.args].join(' '))).toContain('bus:launch --on')
    bench.close()
  })
})
