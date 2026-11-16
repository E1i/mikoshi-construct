import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from '../../../core/events.js'
import type { OverlapDeclarations } from '../../../core/order/overlap.js'
import type { OrderEventSource } from '../../../core/order/turn.js'
import type { MainMerge } from '../../../ports/main-merge.js'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_TYPES_FOLDED_ON_APPEND, CARDS, PROJECTION_TYPES, REDUCED_IN_ORDER } from '../../../core/bus-readings.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { INTERNAL_MODULES_FILE, MODULE_FILES, readDeclarations, trackedFrom, validateDeclarations } from '../../../core/declarations.js'
import { EVENT_CATALOG, READINGS_CATALOG, renderEvents, renderReadings } from '../../../core/declared-events.js'
import { EVENT_PAYLOADS, OWNER_WAIT_OPENED, PR_ORDERED } from '../../../core/events.js'
import { GENERATED_PATHS, isRebuiltOnUpdate } from '../../../core/generated-files.js'
import { overlapDeclarationsOf } from '../../../core/order/overlap.js'
import { BUS_ORDERS, ORDER_ACTOR, orderEventsFrom, orderGroups, PrOrderTick, readOrder } from '../../../core/order/turn.js'
import { BusRead } from '../../../ports/bus-read.js'
import { mainMergeInCardTree } from '../../../ports/main-merge.js'
import { NetWatch } from '../../../ports/netwatch.js'
import { MAIN_BRANCH } from '../../../ports/snapshot.js'
import { Clock, FakeGitHub, sha } from '../github-fake.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const DECLARATIONS = 'declarations'
const EVENTS = path.join(DECLARATIONS, 'events')
const READINGS = path.join(DECLARATIONS, 'readings')
const DERIVED = [EVENT_CATALOG, READINGS_CATALOG, MODULE_FILES]
const GIT_ROUND_TRIPS_TIMEOUT = 180_000
const IDENTITY = ['-c', 'user.name=r-events', '-c', 'user.email=r-events@example.invalid', '-c', 'commit.gpgsign=false']

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

type Bus = ReturnType<typeof openBus>

interface Card {
  pr: number
  files: string[]
  events: Record<string, Record<string, unknown>>
}

interface Catalogs {
  events: string
  readings: string
}

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function repositoryFiles(): string[] {
  const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  return trackedFrom(listing, file => existsSync(path.join(REPO_ROOT, file)))
}

function declare(root: string, cards: readonly Card[]): void {
  for (const card of cards) {
    for (const [key, event] of Object.entries(card.events))
      writeFileSync(path.join(root, EVENTS, `${key}.json`), `${JSON.stringify(event, null, 2)}\n`)
  }
}

function checkout(cards: readonly Card[]): string {
  const root = scratch('r-events-')
  cpSync(path.join(REPO_ROOT, DECLARATIONS), path.join(root, DECLARATIONS), { recursive: true })
  copyFileSync(path.join(REPO_ROOT, INTERNAL_MODULES_FILE), path.join(root, INTERNAL_MODULES_FILE))
  declare(root, cards)
  return root
}

function declarationFiles(card: Card): string[] {
  return Object.keys(card.events).map(key => `${DECLARATIONS}/events/${key}.json`)
}

function catalogsAt(root: string): Catalogs {
  const { events, readings } = readDeclarations(root)
  return { events: renderEvents(events), readings: renderReadings(events, readings) }
}

function rebuild(cards: readonly Card[]): Catalogs {
  const root = checkout(cards)
  const tracked = [...new Set([...repositoryFiles(), ...cards.flatMap(card => [...card.files, ...declarationFiles(card)])])].sort()
  expect(validateDeclarations(readDeclarations(root), tracked)).toEqual([])
  return catalogsAt(root)
}

function onMain(): Catalogs {
  const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return { events: read(EVENT_CATALOG), readings: read(READINGS_CATALOG) }
}

function changedPaths(card: Card): string[] {
  return [...card.files, ...declarationFiles(card), ...DERIVED]
}

function busEvents(db: DatabaseSync): OrderEventSource {
  return orderEventsFrom((type, fields, after) => new BusRead(db, { from: after + 1 }).slice(type as EventType, fields as never))
}

function observedBus(cards: readonly Card[]): { db: Bus, declarations: OverlapDeclarations } {
  const db = openBus(path.join(scratch('r-events-bus-'), 'bus.db'))
  const gitHub = new FakeGitHub()
  cards.forEach((card, at) => gitHub.open({ number: card.pr, files: changedPaths(card), head: sha(String.fromCharCode(97 + at)) }))
  new NetWatch(db, gitHub.client, new Clock().now).poll()
  for (const card of cards)
    appendEvent(db, { ts: '2026-11-17T00:00:01Z', type: PR_ORDERED, actor: ORDER_ACTOR, cardId: null, pr: card.pr, head: null, dedupeKey: `${PR_ORDERED}:${card.pr}:r-events`, payload: { by: BUS_ORDERS }, legacy: false })
  return { db, declarations: overlapDeclarationsOf(readDeclarations()) }
}

function groupsOf(cards: readonly Card[]): { prs: number[], owners: number } {
  const { db, declarations } = observedBus(cards)
  new PrOrderTick(db, busEvents(db), () => '2026-11-17T00:00:30Z', () => declarations, '').step()
  const groups = orderGroups(readOrder(busEvents(db), declarations), declarations)
  const owners = Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(OWNER_WAIT_OPENED) as { n: number }).n)
  db.close()
  return { prs: groups.map(group => group.prs.length), owners }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function writeCatalogs(root: string): void {
  const catalogs = catalogsAt(root)
  writeFileSync(path.join(root, EVENT_CATALOG), catalogs.events)
  writeFileSync(path.join(root, READINGS_CATALOG), catalogs.readings)
}

interface Remote {
  origin: string
  main: string
}

function remote(): Remote {
  const base = scratch('r-events-git-')
  const origin = path.join(base, 'origin.git')
  const main = path.join(base, 'main')
  git(base, ['init', '-q', '--bare', '-b', MAIN_BRANCH, origin])
  git(base, ['init', '-q', '-b', MAIN_BRANCH, main])
  cpSync(path.join(REPO_ROOT, DECLARATIONS), path.join(main, DECLARATIONS), { recursive: true })
  copyFileSync(path.join(REPO_ROOT, INTERNAL_MODULES_FILE), path.join(main, INTERNAL_MODULES_FILE))
  mkdirSync(path.dirname(path.join(main, EVENT_CATALOG)), { recursive: true })
  writeCatalogs(main)
  git(main, ['add', '-A'])
  git(main, ['commit', '-q', '-m', 'main'])
  git(main, ['remote', 'add', 'origin', origin])
  git(main, ['push', '-q', 'origin', MAIN_BRANCH])
  return { origin, main }
}

function branchOf(card: Card): string {
  return `card-${card.pr}`
}

function opened(repo: Remote, card: Card): string {
  const tree = path.join(path.dirname(repo.origin), branchOf(card))
  git(path.dirname(repo.origin), ['clone', '-q', repo.origin, tree])
  git(tree, ['checkout', '-q', '-b', branchOf(card)])
  declare(tree, [card])
  writeCatalogs(tree)
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', branchOf(card)])
  git(tree, ['push', '-q', 'origin', branchOf(card)])
  return tree
}

function mergedOnGitHub(repo: Remote, card: Card): void {
  git(repo.main, ['fetch', '-q', 'origin'])
  git(repo.main, ['merge', '-q', '--no-ff', '--no-edit', `origin/${branchOf(card)}`])
  git(repo.main, ['push', '-q', 'origin', MAIN_BRANCH])
}

function mergedInOrder(cards: readonly Card[]): Catalogs {
  const repo = remote()
  for (const card of cards)
    opened(repo, card)
  for (const card of cards)
    mergedOnGitHub(repo, card)
  const merged = { events: readFileSync(path.join(repo.main, EVENT_CATALOG), 'utf8'), readings: readFileSync(path.join(repo.main, READINGS_CATALOG), 'utf8') }
  expect(merged).toEqual(catalogsAt(repo.main))
  return merged
}

function updatedAndMerged(first: Card, second: Card): { landed: Catalogs, update: MainMerge, rebuilds: string[] } {
  const repo = remote()
  opened(repo, first)
  const tree = opened(repo, second)
  mergedOnGitHub(repo, first)
  const rebuilds: string[] = []
  const update = mainMergeInCardTree(git, () => tree, (cwd, args) => {
    rebuilds.push(args.join(' '))
    writeCatalogs(cwd)
    return { status: 0, stderr: '' }
  })({ cardId: second.pr, branch: branchOf(second), outsideTheCard: () => [], head: git(tree, ['rev-parse', 'HEAD']) })
  mergedOnGitHub(repo, second)
  const landed = { events: readFileSync(path.join(repo.main, EVENT_CATALOG), 'utf8'), readings: readFileSync(path.join(repo.main, READINGS_CATALOG), 'utf8') }
  expect(landed).toEqual(catalogsAt(repo.main))
  return { landed, update, rebuilds }
}

function event(name: string, constant: string, payload: string[] | null): Record<string, unknown> {
  return { event: name, constant, payload }
}

describe('conveyor R-events: EVENT_PAYLOADS and the bus readings are assembled from declarations', () => {
  it('keeps events.ts and the projection types on main equal to a fresh rebuild, each a rebuilt-on-update generated row', () => {
    expect(onMain()).toEqual(rebuild([]))
    for (const file of [EVENT_CATALOG, READINGS_CATALOG]) {
      expect(GENERATED_PATHS).toContain(file)
      expect(isRebuiltOnUpdate(file)).toBe(true)
    }
    expect(EVENT_CATALOG).toBe('scripts/core/events.ts')
  })

  it('declares every catalogued event in its own file, and the readings in theirs', () => {
    const { events, readings } = readDeclarations()
    const catalogued = Object.fromEntries(events.flatMap(each => each.payload === null ? [] : [[each.event, each.payload]]))
    expect(catalogued).toEqual(Object.fromEntries(Object.entries(EVENT_PAYLOADS).map(([type, keys]) => [type, [...keys]])))
    expect(Object.fromEntries(readings.map(reading => [reading.reading, reading.types]))).toEqual(Object.fromEntries(Object.entries(PROJECTION_TYPES).map(([reading, types]) => [reading, [...types].sort()])))
    expect(REDUCED_IN_ORDER).toEqual(readings.filter(reading => reading.reducedInOrder).map(reading => reading.reading))
    expect([...CARD_TYPES_FOLDED_ON_APPEND]).toEqual(readings.find(reading => reading.reading === CARDS)!.foldedOnAppend)
  })

  it('assembles the same output whatever order the declarations arrive in', () => {
    const { events, readings } = readDeclarations()
    expect(renderEvents([...events].reverse())).toBe(renderEvents(events))
    expect(renderReadings([...events].reverse(), [...readings].reverse())).toBe(renderReadings(events, readings))
  })

  it('refuses an unsorted payload, a constant named twice or one the catalog writes itself, and a reading of an undeclared event', () => {
    const root = checkout([{ pr: 0, files: [], events: {
      'probe.unsorted': event('probe.unsorted', 'PROBE_UNSORTED', ['b', 'a']),
      'probe.twice': event('probe.twice', 'CARD_ADMITTED', []),
      'probe.beside': event('probe.beside', 'CARD_WAITS', []),
      'probe.lower': event('probe.lower', 'probeLower', []),
    } }])
    writeFileSync(path.join(root, READINGS, 'probes.json'), JSON.stringify({ reading: 'probes', constant: 'PROBES', reducedInOrder: true, types: ['probe.absent'], foldedOnAppend: null }))
    writeFileSync(path.join(root, READINGS, 'halves.json'), JSON.stringify({ reading: 'halves', constant: 'HALVES', reducedInOrder: true, types: ['card.admitted'], foldedOnAppend: ['card.admitted'] }))
    expect(validateDeclarations(readDeclarations(root), repositoryFiles())).toEqual(expect.arrayContaining([
      'declarations/events/probe.unsorted.json: payload is neither null nor a sorted list of distinct non-empty keys',
      'declarations/events/probe.beside.json: constant "CARD_WAITS" is a name the event catalog writes beside the events',
      'declarations/events/probe.lower.json: constant is not an upper-case identifier',
      'constant CARD_ADMITTED is named by declarations/events/card.admitted.json, declarations/events/probe.twice.json; one declaration names it',
      'declarations/readings/probes.json: reads probe.absent, which declarations/events/ does not declare',
      'declarations/readings/halves.json: a reading is either reduced in order, with foldedOnAppend null, or folds a list of its types on append',
    ]))
  })
})

describe('conveyor R-events: the witnesses', () => {
  it('scenario 06: two cards in different modules each add a file and an event; different groups, no owner wait, and main equals a fresh rebuild in either merge order', { timeout: GIT_ROUND_TRIPS_TIMEOUT }, () => {
    const first: Card = { pr: 601, files: ['scripts/ladder/probe-starter.ts'], events: { 'probe.started': event('probe.started', 'PROBE_STARTED', ['card', 'step']) } }
    const second: Card = { pr: 602, files: ['scripts/window/probe-view.ts'], events: { 'probe.viewed': event('probe.viewed', 'PROBE_VIEWED', ['view']) } }
    expect(groupsOf([first, second])).toEqual({ prs: [1, 1], owners: 0 })

    const merged = rebuild([first, second])
    expect(rebuild([second, first])).toEqual(merged)
    expect([rebuild([first]).events, rebuild([second]).events]).not.toContain(merged.events)
    expect(merged.events).toContain('export const PROBE_STARTED = \'probe.started\'')
    expect(merged.events).toContain('  [PROBE_STARTED]: [\'card\', \'step\'],')
    expect(merged.events).toContain('  [PROBE_VIEWED]: [\'view\'],')
    for (const [one, other] of [[first, second], [second, first]] as const) {
      const { landed, update, rebuilds } = updatedAndMerged(one, other)
      expect(update).toMatchObject({ kind: 'merged', tookMain: [], rebuilt: expect.arrayContaining([EVENT_CATALOG]) })
      expect(rebuilds).toEqual(['declarations:update'])
      expect(landed).toEqual(merged)
    }
  })

  it('scenario 14: a.json and b.json from two PRs land with no update and the catalog holds both; two PRs adding c.json apart are one group, and the second update stops on the file', { timeout: GIT_ROUND_TRIPS_TIMEOUT }, () => {
    const a: Card = { pr: 1401, files: [], events: { a: event('a', 'PROBE_A', ['one']) } }
    const b: Card = { pr: 1402, files: [], events: { b: event('b', 'PROBE_B', ['two']) } }
    expect(groupsOf([a, b])).toEqual({ prs: [1, 1], owners: 0 })
    const landed = mergedInOrder([a, b])
    expect(mergedInOrder([b, a])).toEqual(landed)
    expect(landed).toEqual(rebuild([a, b]))
    expect(landed.events).toContain('  [PROBE_A]: [\'one\'],')
    expect(landed.events).toContain('  [PROBE_B]: [\'two\'],')

    const c: Card = { pr: 1403, files: [], events: { c: event('c', 'PROBE_C', ['three']) } }
    const d: Card = { pr: 1404, files: [], events: { c: event('c', 'PROBE_C', ['four']) } }
    expect(groupsOf([c, d])).toEqual({ prs: [2], owners: 0 })
    const repo = remote()
    opened(repo, c)
    const tree = opened(repo, d)
    mergedOnGitHub(repo, c)
    const head = git(tree, ['rev-parse', 'HEAD'])
    const rebuilds: string[] = []
    const update = mainMergeInCardTree(git, () => tree, (_cwd, args) => {
      rebuilds.push(args.join(' '))
      return { status: 0, stderr: '' }
    })
    expect(update({ cardId: d.pr, branch: branchOf(d), outsideTheCard: () => [], head })).toEqual({ kind: 'inside', files: [`${DECLARATIONS}/events/c.json`] })
    expect(rebuilds).toEqual([])
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(tree, ['ls-remote', 'origin', `refs/heads/${branchOf(d)}`]).split('\t')[0]).toBe(head)
  })
})
