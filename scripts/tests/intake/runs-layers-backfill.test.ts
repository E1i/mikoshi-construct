import type { DatabaseSync } from 'node:sqlite'
import type { CheckCatalog } from '../../ci/card-runs.js'
import type { LayerMap } from '../../core/layer-map.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { BUS_DB_VARIABLE, openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { busCardAdmissions, busCardEvents, busHeldCards } from '../../intake/intake.js'
import { backfillRunsLayers, collapseOf } from '../../intake/runs-layers-backfill.js'
import { busProjections } from '../../supervisor/composition.js'

const NOW = new Date('2026-11-05T09:00:00.000Z')
const TOUCH = 'src/board/run.ts'
const ONE = 'tests/one.test.ts'
const TWO = 'tests/two.test.ts'
const OTHER = 'tests/other.test.ts'
const MAP: LayerMap = { files: {}, folders: { 'src/': 'src', 'scripts/core/': 'core' } }
const CATALOG: CheckCatalog = {
  testLayers: new Map([[ONE, ['src']], [TWO, ['src']], [OTHER, ['core']]]),
  moduleLayers: new Map([[TOUCH, ['src']]]),
}
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function witness(id: string): Record<string, unknown> {
  return { id, run: `pnpm exec vitest run tests/${id}.test.ts`, test: `the ${id} test`, head: 'pass', base: 'fail', proves: `what ${id} proves` }
}

function body(id: number, runs: readonly string[], touch = TOUCH): string {
  return `card: #${id} backfill-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touch}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nruns: ${JSON.stringify(runs)}\nwitnesses: ${JSON.stringify([witness('W1')])}\n`
}

interface World { db: DatabaseSync, repo: string, root: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'runs-layers-backfill-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  mkdirSync(path.join(root, '.construct', 'parking'), { recursive: true })
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  vi.stubEnv('HOME', root)
  return { db: openBus(bus), repo, root }
}

function admitted(w: World, id: number, text: string): void {
  const result = runAdmit({ file: path.join(w.root, `${id}.md`), body: text, dir: w.repo, dryRun: false, autoConfirm: true, events: busCardEvents(w.db), admissions: busCardAdmissions(w.db), cardStates: () => busHeldCards(w.db) }, () => NOW)
  expect(result.status).toBe('admitted')
  reduce(w.db, 'pending', busProjections())
}

function bodyOf(w: World, id: number): string {
  return (w.db.prepare('SELECT text FROM card_bodies WHERE card_id = ?').get(id) as { text: string }).text
}

function eventOf(w: World, id: number): number {
  return (w.db.prepare('SELECT event_id FROM cards WHERE card_id = ?').get(id) as { event_id: number }).event_id
}

function backfilled(w: World, write: boolean) {
  return backfillRunsLayers(w.db, { write, dir: w.repo, catalog: CATALOG, map: MAP, now: () => NOW })
}

describe('collapseOf', () => {
  it('entries naming every test of a layer collapse and entries covering part of it stay', () => {
    const whole = collapseOf(1, body(1, [ONE, TWO, 'tests/unlisted.test.ts']), CATALOG, MAP)
    expect(whole).toMatchObject({ kind: 'collapse', layers: ['src'], dropped: [ONE, TWO], runs: ['tests/unlisted.test.ts', 'layer:src'] })
    expect(collapseOf(2, body(2, [ONE]), CATALOG, MAP)).toBeNull()
  })

  it('a glob naming the whole layer collapses and a glob reaching past it stays', () => {
    const catalog: CheckCatalog = { ...CATALOG, testLayers: new Map([['tests/board/one.test.ts', ['src']], ['tests/board/two.test.ts', ['src']], [OTHER, ['core']]]) }
    expect(collapseOf(1, body(1, ['tests/board/**']), catalog, MAP)).toMatchObject({ kind: 'collapse', layers: ['src'], dropped: ['tests/board/**'] })
    const reaching: CheckCatalog = { ...CATALOG, testLayers: new Map([['tests/board/one.test.ts', ['src']], ['tests/board/two.test.ts', ['core']], [OTHER, ['core']]]) }
    expect(collapseOf(2, body(2, ['tests/board/**']), reaching, MAP)).toBeNull()
  })

  it('a layer the map does not know never replaces an entry', () => {
    const catalog: CheckCatalog = { ...CATALOG, testLayers: new Map([[ONE, ['ghost']]]) }
    expect(collapseOf(1, body(1, [ONE]), catalog, MAP)).toBeNull()
  })

  it('a prose Runs line collapses into the runs field', () => {
    const text = body(1, []).replace('runs: []\n', `Runs: ${ONE}, ${TWO}\n`)
    const collapse = collapseOf(1, text, CATALOG, MAP)
    expect(collapse).toMatchObject({ kind: 'collapse', runs: ['layer:src'] })
    expect(collapse?.kind === 'collapse' ? collapse.text : '').not.toContain('Runs: ')
  })

  it('a collapse that would change the tests of the card stays and says so', () => {
    const catalog: CheckCatalog = {
      testLayers: new Map([[ONE, ['src']], [TWO, ['core']]]),
      moduleLayers: new Map([['tests/followed.test.ts', ['src', 'core']]]),
    }
    const collapse = collapseOf(1, body(1, [ONE, TWO], 'tests/followed.test.ts'), catalog, MAP)
    expect(collapse).toEqual({ kind: 'stays', why: 'the tests of the card would change: 3 → 2' })
  })

  it('a full reading stays and prints its why', () => {
    expect(collapseOf(1, body(1, [ONE, TWO], 'nowhere/x.ts'), CATALOG, MAP)).toEqual({ kind: 'stays', why: 'a full reading: nowhere/x.ts belongs to no layer of the check catalog' })
  })

  it('collapsing what is already collapsed finds nothing', () => {
    expect(collapseOf(1, body(1, ['layer:src']), CATALOG, MAP)).toBeNull()
  })
})

describe('backfillRunsLayers', () => {
  it('a running closed or open pull request card is skipped and named', () => {
    const w = world()
    for (const id of [10, 11, 12, 13])
      admitted(w, id, body(id, [ONE, TWO]))
    w.db.prepare(`UPDATE cards SET state = 'running' WHERE card_id = 10`).run()
    w.db.prepare(`UPDATE cards SET state = 'closed' WHERE card_id = 11`).run()
    w.db.prepare(`INSERT INTO prs (pr, card_id, state, event_id) VALUES (40, 12, 'open', ?)`).run(eventOf(w, 12))
    w.db.prepare(`INSERT INTO tasks (task_key, queue, card_id, state, event_id) VALUES ('launch:13', 'launch', 13, 'leased', ?)`).run(eventOf(w, 13))
    const before = [10, 11, 12, 13].map(id => bodyOf(w, id))

    expect(backfilled(w, true)).toEqual([
      { card: 10, kind: 'skipped', why: 'its session is running' },
      { card: 11, kind: 'skipped', why: 'it is closed' },
      { card: 12, kind: 'skipped', why: 'pull request #40 is open' },
      { card: 13, kind: 'skipped', why: 'its session is running' },
    ])
    reduce(w.db, 'pending', busProjections())
    expect([10, 11, 12, 13].map(id => bodyOf(w, id))).toEqual(before)
  })

  it('a dry run prints what it would write and writes nothing', () => {
    const w = world()
    admitted(w, 20, body(20, [ONE, TWO]))
    const before = bodyOf(w, 20)
    const events = w.db.prepare('SELECT count(*) AS n FROM events').get()

    expect(backfilled(w, false)).toEqual([{ card: 20, kind: 'would write', layers: ['src'], dropped: [ONE, TWO], runs: ['layer:src'], corrections: [] }])
    reduce(w.db, 'pending', busProjections())
    expect(bodyOf(w, 20)).toBe(before)
    expect(w.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual(events)
  })

  it('a write goes as a card.admitted, over no parking file, and a second run finds nothing', () => {
    const w = world()
    admitted(w, 21, body(21, [ONE, TWO]))

    expect(backfilled(w, true)).toMatchObject([{ card: 21, kind: 'written', runs: ['layer:src'] }])
    reduce(w.db, 'pending', busProjections())
    expect(bodyOf(w, 21)).toContain('runs: ["layer:src"]')
    expect(busCardAdmissions(w.db)(21)?.text).toContain('runs: ["layer:src"]')
    expect(readdirSync(path.join(w.root, '.construct', 'parking'))).toEqual([])
    expect(existsSync(path.join(w.root, '.construct', 'parking', '21.md'))).toBe(false)
    expect(backfilled(w, true)).toEqual([])
  })
})
