import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from '../../../core/events.js'
import type { OverlapDeclarations } from '../../../core/order/overlap.js'
import type { OrderEventSource } from '../../../core/order/turn.js'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_SHARED, CHANGESET_READERS } from '../../../ci/layers.js'
import { BUS_CONTRACT } from '../../../core/bus-adapter.js'
import { openOwnerWaits } from '../../../core/card-readings.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { ASSEMBLED_LAYER_MAP, FACTORY_PATHS, INTERNAL_MODULES_FILE, layerMapOf, MODULE_FILES, moduleFilesOf, readDeclarations, renderFactoryPaths, renderLayerMap, renderModuleFiles, trackedFrom, validateDeclarations } from '../../../core/declarations.js'
import { OWNER_WAIT_OPENED, PR_ORDERED } from '../../../core/events.js'
import { FACTORY_LISTS, FACTORY_NAMED, FACTORY_RUNTIME, FACTORY_WORKERS } from '../../../core/factory-paths.js'
import { GENERATED_PATHS, isRebuiltOnUpdate } from '../../../core/generated-files.js'
import { overlapDeclarationsOf } from '../../../core/order/overlap.js'
import { BUS_ORDERS, ORDER_ACTOR, orderEventsFrom, orderGroups, PrOrderTick, readOrder } from '../../../core/order/turn.js'
import { LAW_NODES } from '../../../nodes/laws.js'
import { BusRead } from '../../../ports/bus-read.js'
import { SHARED_BUS_CODE } from '../../../supervisor/supervisor.js'
import { Clock, FakeGitHub, sha } from '../github-fake.js'
import { benchNetWatch } from '../net-watch-bench.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const DECLARATIONS = 'declarations'
const ENTRIES = path.join(DECLARATIONS, 'entries')
const DERIVED = [FACTORY_PATHS, ASSEMBLED_LAYER_MAP, MODULE_FILES]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

type Bus = ReturnType<typeof openBus>

interface Card {
  pr: number
  files: string[]
  entries: Record<string, Record<string, unknown>>
}

interface Registries {
  factoryPaths: string
  layerMap: string
  moduleFiles: string
}

function repositoryFiles(): string[] {
  const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  return trackedFrom(listing, file => existsSync(path.join(REPO_ROOT, file)))
}

function checkout(cards: readonly Card[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'r-paths-'))
  roots.push(root)
  cpSync(path.join(REPO_ROOT, DECLARATIONS), path.join(root, DECLARATIONS), { recursive: true })
  copyFileSync(path.join(REPO_ROOT, INTERNAL_MODULES_FILE), path.join(root, INTERNAL_MODULES_FILE))
  for (const card of cards) {
    for (const [key, entry] of Object.entries(card.entries))
      writeFileSync(path.join(root, ENTRIES, `${key}.json`), JSON.stringify(entry))
  }
  return root
}

function declarationFiles(card: Card): string[] {
  return Object.keys(card.entries).map(key => `${DECLARATIONS}/entries/${key}.json`)
}

function trackedWith(cards: readonly Card[]): string[] {
  return [...new Set([...repositoryFiles(), ...cards.flatMap(card => [...card.files, ...declarationFiles(card)])])].sort()
}

function rebuild(cards: readonly Card[]): Registries {
  const declarations = readDeclarations(checkout(cards))
  const tracked = trackedWith(cards)
  expect(validateDeclarations(declarations, tracked)).toEqual([])
  return {
    factoryPaths: renderFactoryPaths(declarations.workers, declarations.entries, declarations.generated),
    layerMap: renderLayerMap(layerMapOf(declarations.workers, declarations.entries, tracked)),
    moduleFiles: renderModuleFiles(moduleFilesOf(declarations.modules, tracked)),
  }
}

function onMain(): Registries {
  const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return { factoryPaths: read(FACTORY_PATHS), layerMap: read(ASSEMBLED_LAYER_MAP), moduleFiles: read(MODULE_FILES) }
}

function changedPaths(card: Card): string[] {
  return [...card.files, ...declarationFiles(card), ...DERIVED]
}

function busEvents(db: DatabaseSync): OrderEventSource {
  return orderEventsFrom((type, fields, after) => new BusRead(db, { from: after + 1 }).slice(type as EventType, fields as never))
}

function observedBus(cards: readonly Card[]): { db: Bus, declarations: OverlapDeclarations } {
  const root = mkdtempSync(path.join(tmpdir(), 'r-paths-bus-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  cards.forEach((card, at) => gitHub.open({ number: card.pr, files: changedPaths(card), head: sha(String.fromCharCode(97 + at)) }))
  benchNetWatch(db, gitHub.client, new Clock().now).poll()
  for (const card of cards)
    appendEvent(db, { ts: '2026-11-15T00:00:01Z', type: PR_ORDERED, actor: ORDER_ACTOR, cardId: null, pr: card.pr, head: null, dedupeKey: `${PR_ORDERED}:${card.pr}:r-paths`, payload: { by: BUS_ORDERS }, legacy: false })
  return { db, declarations: overlapDeclarationsOf(readDeclarations()) }
}

function groupsOf(cards: readonly Card[]): { prs: number[], owners: number } {
  const { db, declarations } = observedBus(cards)
  new PrOrderTick(BUS_CONTRACT, db, busEvents(db), () => '2026-11-15T00:00:30Z', () => declarations, '', () => openOwnerWaits(db)).step()
  const groups = orderGroups(readOrder(busEvents(db), declarations), declarations)
  const owners = Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(OWNER_WAIT_OPENED) as { n: number }).n)
  db.close()
  return { prs: groups.map(group => group.prs.length), owners }
}

describe('conveyor R-paths: factory-paths, the layer lists and layer-map are assembled from declarations', () => {
  it('keeps factory-paths.ts, layer-map.json and module-files.json on main equal to a fresh rebuild, and every derived path a rebuilt-on-update generated row', () => {
    expect(onMain()).toEqual(rebuild([]))
    for (const file of DERIVED) {
      expect(GENERATED_PATHS).toContain(file)
      expect(isRebuiltOnUpdate(file)).toBe(true)
    }
    expect(FACTORY_RUNTIME.layerMap).toBe(ASSEMBLED_LAYER_MAP)
    expect(FACTORY_NAMED.factoryRegistry).toBe(FACTORY_PATHS)
  })

  it('derives one list of shared bus code for the selector and the supervisor, the changeset readers, and the law nodes from the workers', () => {
    expect(BUS_SHARED).toBe(FACTORY_LISTS.busShared)
    expect(SHARED_BUS_CODE).toBe(FACTORY_LISTS.busShared)
    expect(CHANGESET_READERS).toBe(FACTORY_LISTS.changesetReaders)
    expect(LAW_NODES).toEqual(Object.keys(FACTORY_WORKERS))
    const { workers } = readDeclarations()
    expect(Object.fromEntries(workers.map(worker => [worker.worker, worker.path]))).toEqual(FACTORY_WORKERS)
  })

  it('assembles the same output whatever order the entries arrive in', () => {
    const { workers, entries, generated } = readDeclarations()
    const tracked = repositoryFiles()
    expect(renderFactoryPaths([...workers].reverse(), [...entries].reverse(), generated)).toBe(renderFactoryPaths(workers, entries, generated))
    expect(renderLayerMap(layerMapOf([...workers].reverse(), [...entries].reverse(), [...tracked].reverse()))).toBe(renderLayerMap(layerMapOf(workers, entries, tracked)))
  })

  it('refuses an entry placed twice, a layer on a path the worker files place, a layer on an entry of a list group, and an entry or worker path that is not tracked', () => {
    const root = checkout([{ pr: 0, files: [], entries: {
      twiceA: { entry: 'twiceA', group: null, path: 'scripts/window/window.ts', layer: 'window', lists: [] },
      twiceB: { entry: 'twiceB', group: null, path: 'scripts/window/window.ts', layer: 'bus', lists: [] },
      derived: { entry: 'derived', group: null, path: 'scripts/nodes/merge/merge-executor.ts', layer: 'bus', lists: [] },
      gone: { entry: 'gone', group: 'named', path: 'scripts/window/gone.ts', layer: null, lists: [] },
      odd: { entry: 'odd', group: 'folders', path: 'scripts/window', layer: null, lists: ['nothing'] },
      layered: { entry: 'layered', group: 'formerFolders', paths: ['scripts/window'], layer: 'window', lists: [] },
    } }])
    writeFileSync(path.join(root, DECLARATIONS, 'workers', 'ghost.json'), JSON.stringify({ worker: 'ghost', path: 'scripts/nodes/ghost/ghost-worker.ts' }))
    expect(validateDeclarations(readDeclarations(root), repositoryFiles())).toEqual(expect.arrayContaining([
      'declarations/workers/ghost.json: path "scripts/nodes/ghost/ghost-worker.ts" is not a tracked file',
      'declarations/entries/odd.json: paths is not a list of non-empty strings, or path is given beside it, in a group of lists',
      'declarations/entries/odd.json: lists is not a list of busShared, changesetReaders',
      'declarations/entries/layered.json: layer places one path, and this entry holds a list',
      'declarations/entries/gone.json: path "scripts/window/gone.ts" is neither a tracked file nor a folder holding one',
      'declarations/entries/derived.json: layer places "scripts/nodes/merge/merge-executor.ts", which bus:merge places already from the worker files',
      '"scripts/window/window.ts" is placed by twiceA, twiceB; one entry places it',
    ]))
  })

  it('a list entry carrying a layer is refused', () => {
    const root = checkout([{ pr: 0, files: [], entries: {
      layered: { entry: 'layered', group: 'folders', paths: ['scripts/window'], layer: 'window', lists: [] },
    } }])
    expect(validateDeclarations(readDeclarations(root), repositoryFiles())).toContain('declarations/entries/layered.json: layer places one path, and this entry holds a list')
  })
})

describe('conveyor R-paths: the witnesses', () => {
  it('scenario 06: two cards in different modules each add a file and its entry; they stay in different groups, open no owner wait, and main equals a fresh rebuild in either merge order', () => {
    const first: Card = {
      pr: 601,
      files: ['scripts/ladder/probe-starter.ts'],
      entries: { probeStarter: { entry: 'probeStarter', group: 'runtime', path: 'scripts/ladder/probe-starter.ts', layer: null, lists: [] } },
    }
    const second: Card = {
      pr: 602,
      files: ['scripts/window/probe-view.ts'],
      entries: { probeView: { entry: 'probeView', group: 'named', path: 'scripts/window/probe-view.ts', layer: 'bus', lists: ['busShared'] } },
    }
    expect(groupsOf([first, second])).toEqual({ prs: [1, 1], owners: 0 })
    expect(groupsOf([second])).toEqual({ prs: [1], owners: 0 })

    const alone = [rebuild([first]), rebuild([second])]
    const merged = rebuild([first, second])
    expect(rebuild([second, first])).toEqual(merged)
    expect(alone.map(registries => registries.factoryPaths)).not.toContain(merged.factoryPaths)
    expect(merged.factoryPaths).toContain('probeStarter: \'scripts/ladder/probe-starter.ts\'')
    expect(merged.factoryPaths).toContain('probeView: \'scripts/window/probe-view.ts\'')
    expect(merged.factoryPaths).toContain('\'scripts/supervisor/stamp.ts\', \'scripts/window/probe-view.ts\']')
    const layers = JSON.parse(merged.layerMap) as { files: Record<string, string> }
    expect(layers.files['scripts/ladder/probe-starter.ts']).toBe('bus:probe')
    expect(layers.files['scripts/window/probe-view.ts']).toBe('bus')
    expect(JSON.parse(merged.moduleFiles)).toMatchObject({ ladder: expect.arrayContaining(['scripts/ladder/probe-starter.ts']), window: expect.arrayContaining(['scripts/window/probe-view.ts']) })
  })

  it('scenario 10: two cards of one module add different files under its pattern and edit no declaration, a third works elsewhere; three groups, and main equals a fresh rebuild after both merge', () => {
    const alpha: Card = { pr: 1001, files: ['scripts/ladder/alpha-starter.ts'], entries: {} }
    const beta: Card = { pr: 1002, files: ['scripts/ladder/beta-starter.ts'], entries: {} }
    const elsewhere: Card = { pr: 1003, files: ['docs/guide/r-paths-new-page.md'], entries: {} }
    expect(groupsOf([alpha, beta, elsewhere])).toEqual({ prs: [1, 1, 1], owners: 0 })
    expect([alpha, beta, elsewhere].flatMap(changedPaths).filter(file => file.startsWith(`${DECLARATIONS}/`))).toEqual([])

    const merged = rebuild([alpha, beta])
    expect(rebuild([beta, alpha])).toEqual(merged)
    expect(merged.factoryPaths).toBe(onMain().factoryPaths)
    expect(merged.moduleFiles).not.toBe(rebuild([alpha]).moduleFiles)
    expect((JSON.parse(merged.moduleFiles) as Record<string, string[]>).ladder).toEqual(expect.arrayContaining(['scripts/ladder/alpha-starter.ts', 'scripts/ladder/beta-starter.ts']))
    const layers = JSON.parse(merged.layerMap) as { files: Record<string, string> }
    expect([layers.files['scripts/ladder/alpha-starter.ts'], layers.files['scripts/ladder/beta-starter.ts']]).toEqual(['bus:alpha', 'bus:beta'])
  })
})
