import type { DatabaseSync } from 'node:sqlite'
import type { CardStart, CardStarter, LaunchOutcome, QueuedCard, StartedCard } from '../../bus/launch-executor.js'
import type { StarterPlaces, StarterPorts } from '../../bus/launch-starter.js'
import type { Lease } from '../../bus/lease.js'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { parkingLane } from '../../bus/admissions.js'
import { ARCHIVE_DIR } from '../../bus/card-archive.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { importJournal, legacyEventOf } from '../../bus/import.js'
import { CARD_STARTED, CARD_STOPPED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { LaunchExecutor } from '../../bus/launch-executor.js'
import { cardCommand, killQuietly, psPgid, ShiftCardStarter, spawnDetached } from '../../bus/launch-starter.js'
import { LaunchWorker } from '../../bus/launch-worker.js'
import { leaseNext } from '../../bus/lease.js'
import { journalIntake } from '../../bus/run.js'
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

const admission = (cardId: number): string => `admission-${cardId}`
const launch = (cardId: number, generation = admission(cardId)): string => taskKey({ queue: 'launch', cardId, generation })

class FakeStarter implements CardStarter {
  starts: QueuedCard[] = []
  stops: StartedCard[] = []
  constructor(private readonly answer: (card: QueuedCard) => CardStart = card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } })) {}
  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return this.answer(card)
  }

  stop(card: StartedCard): void {
    this.stops.push(card)
  }
}

function launchBench(starter: CardStarter = new FakeStarter(), intake?: Parameters<typeof mergeBench>[0]) {
  const bench = mergeBench(intake)
  const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now })
  const ts = (): string => bench.clock.now().toISOString()
  return {
    ...bench,
    admit: (cardId: number, lane: string, depends: number[] = []): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends, admission: admission(cardId) }, legacy: false })
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1)
    await sleep(50)
}

function realStarter(root: string, shiftClaude: string | undefined, cardId: number, overrides: Partial<StarterPorts> = {}, places: Partial<StarterPlaces> = {}): ShiftCardStarter {
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
    kill: killQuietly,
    uuid: () => `session-${cardId}`,
    ...overrides,
  }
  return new ShiftCardStarter({ parking, launchDir: path.join(root, 'launch'), header: 'card {{card}} in {{worktree}}, report {{report}}\n\n', env, claude: shiftClaude ?? 'claude', ...places }, ports)
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

  it('a card whose pull request is merged or that a legacy shift started is not offered for launch', () => {
    const bench = launchBench()
    bench.mergedPr(815)
    bench.admit(915, 'lane-a')
    bench.admit(916, 'lane-b')
    bench.admit(917, 'lane-c')
    bench.admit(918, 'lane-d')
    importJournal(bench.db, [
      JSON.stringify({ event: 'path', task: '916', path: 'cheap', started: '2026-10-01T05:00:00Z', branch: 'feat/card-916', ts: '2026-10-01T05:00:00Z' }),
      JSON.stringify({ event: 'merge', task: '917', pr: 817, by: 'eli', commit: 'abc', ts: '2026-10-01T06:00:00Z' }),
    ].join('\n'))
    bench.tick()

    expect(taskState(bench.db, launch(915))).toBeUndefined()
    expect(taskState(bench.db, launch(916))).toBeUndefined()
    expect(taskState(bench.db, launch(917))).toBeUndefined()
    expect(taskState(bench.db, launch(918))).toMatchObject({ state: 'queued' })
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
    const starter = new FakeStarter(card => ({ kind: 'started', card: { session: 's', worktree: '/t', branch: 'b', base: 'f'.repeat(40), pid: 5000 + card.cardId, pgid: 1 } }))
    const bench = launchBench(starter)
    bench.admit(925, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'denied', denial: { reason: 'not_detached' }, next: 'queued' })
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([])
    expect(starter.stops.map(card => card.pid)).toEqual([5925])
    bench.close()
  })

  it('a session denied as not detached is killed, so it does not run untracked in its worktree', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const bench = launchBench(realStarter(root, stub.command, 926, { pgidOf: () => 1 }))
    bench.admit(926, 'lane-x')
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'not_detached' }, next: 'queued' })
    await waitForExit(groups.at(-1)!)
    expect(alive(groups.at(-1)!)).toBe(false)
    bench.close()
  })

  it('a session whose process group cannot be read is killed before start_failed', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const unreadableGroup = (): never => {
      throw new Error('ps: no such process')
    }
    const bench = launchBench(realStarter(root, stub.command, 927, { pgidOf: unreadableGroup }))
    bench.admit(927, 'lane-x')
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'start_failed' }, next: 'queued' })
    await waitForExit(groups.at(-1)!)
    expect(alive(groups.at(-1)!)).toBe(false)
    bench.close()
  })

  it('a session started while its card was started elsewhere is killed with its process group', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    let bench: ReturnType<typeof launchBench> | undefined
    const real = realStarter(root, stub.command, 946)
    const starter: CardStarter = {
      start: (card) => {
        const start = real.start(card)
        bench!.started(card.cardId)
        return start
      },
      stop: card => real.stop(card),
    }
    bench = launchBench(starter)
    bench.admit(946, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!)).toEqual({ kind: 'fenced', taskKey: launch(946) })
    await waitForExit(groups.at(-1)!)
    expect(alive(groups.at(-1)!)).toBe(false)
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([{ session: 'earlier' }])
    bench.close()
  })

  it('a launch pins the card mode the way relaunch pins the Operator mode', () => {
    expect(cardCommand('claude')).toBe(OPERATOR_CLAUDE)
  })

  it('a launch worker started from an auto window starts the card session in dontAsk', () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const bench = launchBench(realStarter(root, `${stub.command} --permission-mode auto`, 934, {}, { claude: stub.command }))
    bench.admit(934, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!).kind).toBe('started')
    const [args, card] = waitFor(stub.argsFile).trim().split('\n')
    expect(args).toBe('--permission-mode dontAsk -p --session-id session-934')
    expect(card).toBe('card=934')
    bench.close()
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
    expect(starter.stops.map(card => card.pid)).toEqual([7])
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

function cardText(cardId: number, depends = '—'): string {
  return `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends ${depends} · blocks —`
}

function intakeLine(cardId: number, source: string, minute: number, depends?: string): string {
  return JSON.stringify({ event: 'intake', task: String(cardId), card: cardText(cardId, depends), confirmation: 'auto', corrections: [], bodySha: `body${minute}`, source, ts: `2026-10-10T13:${String(minute).padStart(2, '0')}:00.000Z` })
}

function moveLine(cardId: number, from: string, to: string, minute: number): string {
  return JSON.stringify({ event: 'intake-move', task: String(cardId), from, to, bodySha: `body${minute}`, ts: `2026-10-10T13:${String(minute).padStart(2, '0')}:00.000Z` })
}

function journalBench(starter: CardStarter = new FakeStarter()) {
  const root = tempRoot()
  const parking = path.join(root, 'parking')
  const journal = path.join(root, 'ghosts.jsonl')
  writeFileSync(journal, '')
  const lines: string[] = []
  const bench = launchBench(starter, (db, clock) => journalIntake(db, journal, parkingLane(parking), clock.now))
  return {
    ...bench,
    parking,
    park: (cardId: number, lane: string): void => {
      mkdirSync(path.join(parking, lane), { recursive: true })
      writeFileSync(path.join(parking, lane, `${cardId}.md`), cardText(cardId))
    },
    append: (line: string): string => {
      lines.push(line)
      appendFileSync(journal, `${line}\n`)
      return legacyEventOf(line, lines.length)!.dedupeKey
    },
  }
}

function admittedRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`SELECT ts, actor, card_id, dedupe_key, payload FROM events WHERE type = '${CARD_ADMITTED}' ORDER BY id`).all() as Record<string, unknown>[]
}

function launchTasks(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'launch' ORDER BY id`).all() as Record<string, unknown>[]
}

describe('card.admitted from the intake journal', () => {
  it('an intake admit line in the journal enqueues a launch task with no manual step', () => {
    const bench = journalBench()
    bench.park(970, 'lane-q')
    const line = bench.append(intakeLine(970, 'admit', 1))
    bench.tick()

    expect(eventsOf(bench.db, CARD_ADMITTED)).toEqual([{ lane: 'lane-q', depends: [], decision: 'auto', contour: 'cheap', admission: line }])
    expect(line).toMatch(/^legacy:1:[0-9a-f]{64}$/)
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:970:${line}`, state: 'queued' }])
    expect(bench.leaseLaunch()).toMatchObject({ taskKey: `launch:970:${line}`, cardId: 970, pr: null, head: null, leaseGen: 1 })
    bench.close()
  })

  it('a card queued in its lane now gets exactly one launch task', () => {
    const bench = journalBench()
    bench.park(983, 'lane-q')
    const line = bench.append(intakeLine(983, 'admit', 1))
    bench.tick()
    bench.tick()

    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:983:${line}`, state: 'queued' }])
    bench.close()
  })

  it('a replay of the whole journal queues no launch for a closed or archived card', () => {
    const bench = journalBench()
    bench.park(984, 'lane-q')
    bench.park(985, ARCHIVE_DIR)
    bench.append(intakeLine(984, 'admit', 1))
    bench.append(intakeLine(985, 'admit', 2))
    bench.append(intakeLine(986, 'admit', 3))
    rmSync(path.join(bench.parking, 'lane-q', '984.md'))
    bench.tick()
    bench.tick()

    expect(launchTasks(bench.db)).toEqual([])
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })

  it('a second admit after the card fell enqueues a new launch', () => {
    const starter = new FakeStarter()
    const bench = journalBench(starter)
    bench.park(971, 'lane-q')
    const first = bench.append(intakeLine(971, 'admit', 1))
    bench.tick()
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:971:${first}` })

    const again = bench.append(intakeLine(971, 'admit', 2))
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:971:${first}`, state: 'completed' }])

    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STOPPED, actor: 'policy', cardId: 971, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:971`, payload: { reason: 'fault' }, legacy: false })
    const third = bench.append(intakeLine(971, 'admit', 3))
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([
      { task_key: `launch:971:${first}`, state: 'completed' },
      { task_key: `launch:971:${third}`, state: 'queued' },
    ])
    expect(third).not.toBe(again)
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:971:${third}` })
    expect(starter.starts).toEqual([{ cardId: 971, lane: 'lane-q' }, { cardId: 971, lane: 'lane-q' }])
    bench.close()
  })

  it('a second admit after the card fell enqueues a new launch even after its task:start path line was imported', () => {
    const starter = new FakeStarter()
    const bench = journalBench(starter)
    bench.park(974, 'lane-q')
    const first = bench.append(intakeLine(974, 'admit', 1))
    bench.tick()
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:974:${first}` })
    bench.append(JSON.stringify({ event: 'path', task: '974', path: 'cheap', started: '2026-10-10T13:01:30.000Z', worktree: '/tmp/mc-974', branch: 'feat/card-974', card: cardText(974), ts: '2026-10-10T13:01:30.000Z' }))
    bench.tick()

    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STOPPED, actor: 'policy', cardId: 974, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:974`, payload: { reason: 'fault' }, legacy: false })
    const again = bench.append(intakeLine(974, 'admit', 2))
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([
      { task_key: `launch:974:${first}`, state: 'completed' },
      { task_key: `launch:974:${again}`, state: 'queued' },
    ])
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:974:${again}` })
    expect(starter.starts).toEqual([{ cardId: 974, lane: 'lane-q' }, { cardId: 974, lane: 'lane-q' }])
    bench.close()
  })

  it('an admit line and its task:start path line imported in one tick offer no launch', () => {
    const bench = journalBench()
    bench.park(979, 'lane-q')
    bench.append(intakeLine(979, 'admit', 1))
    bench.append(JSON.stringify({ event: 'path', task: '979', path: 'cheap', started: '2026-10-10T13:01:30.000Z', worktree: '/tmp/mc-979', branch: 'feat/card-979', card: cardText(979), ts: '2026-10-10T13:01:30.000Z' }))
    bench.tick()

    expect(admittedRows(bench.db)).toHaveLength(1)
    expect(launchTasks(bench.db)).toEqual([])
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })

  it('a redelivered admit line enqueues no second launch task', () => {
    const bench = journalBench()
    bench.park(972, 'lane-q')
    const line = bench.append(intakeLine(972, 'admit', 1))
    bench.tick()
    bench.tick()
    expect(importJournal(bench.db, readFileSync(path.join(path.dirname(bench.parking), 'ghosts.jsonl'), 'utf8'), parkingLane(bench.parking), bench.clock.now)).toMatchObject({ imported: 0, admitted: 0 })
    bench.tick()

    expect(admittedRows(bench.db)).toHaveLength(1)
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:972:${line}`, state: 'queued' }])
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started' })
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:972:${line}`, state: 'completed' }])
    bench.close()
  })

  it('a replay of the journal yields the same card.admitted events', () => {
    const root = tempRoot()
    const parking = path.join(root, 'parking')
    for (const [cardId, lane] of [[973, 'lane-a'], [974, 'lane-b']] as const) {
      mkdirSync(path.join(parking, lane), { recursive: true })
      writeFileSync(path.join(parking, lane, `${cardId}.md`), cardText(cardId))
    }
    const journal = [
      intakeLine(973, 'admit', 1, '#900'),
      moveLine(973, path.join(parking, 'lane-a'), path.join(parking, 'lane-c'), 2),
      intakeLine(973, 'admit', 3, '#900'),
      intakeLine(974, 'admit', 4),
      intakeLine(974, 'amend', 5),
    ].join('\n')
    const clock = () => new Date('2026-10-10T15:00:00.000Z')
    const first = openBus(path.join(root, 'first.db'))
    const second = openBus(path.join(root, 'second.db'))
    importJournal(first, journal, parkingLane(parking), clock)
    importJournal(second, journal, parkingLane(parking), clock)
    const recorded = admittedRows(first)

    expect(recorded.map(row => [row.card_id, JSON.parse(String(row.payload)).lane, JSON.parse(String(row.payload)).depends])).toEqual([
      [973, 'lane-a', [900]],
      [973, 'lane-c', [900]],
      [973, 'lane-c', [900]],
      [974, 'lane-b', []],
    ])
    expect(recorded.every(row => row.actor === 'reducer')).toBe(true)
    expect(admittedRows(second)).toEqual(recorded)

    renameSync(path.join(parking, 'lane-b'), path.join(parking, 'lane-z'))
    importJournal(first, journal, parkingLane(parking), () => new Date('2026-10-11T00:00:00.000Z'))
    expect(admittedRows(first)).toEqual(recorded)
    first.close()
    second.close()
  })

  it('an intake amend line produces no card.admitted and no launch', () => {
    const bench = journalBench()
    bench.park(975, 'lane-q')
    bench.append(intakeLine(975, 'amend', 1))
    bench.append(JSON.stringify({ event: 'intake', task: '975', card: cardText(975), source: 'retell', ts: '2026-10-10T13:02:00.000Z' }))
    bench.append(JSON.stringify({ event: 'intake', task: '975', card: cardText(975), ts: '2026-10-10T13:03:00.000Z' }))
    bench.tick()
    bench.tick()

    expect(admittedRows(bench.db)).toEqual([])
    expect(launchTasks(bench.db)).toEqual([])
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })
})
