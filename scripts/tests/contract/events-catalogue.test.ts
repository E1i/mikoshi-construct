import type { ParsedFile } from '../../contract/factory/walk.js'
import type { Fold } from '../../core/stored.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { catalogueOf, typedReading, writtenEvents } from '../../contract/factory/payloads.js'
import { parsedFiles } from '../../contract/factory/walk.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, declaredPayload, EVENT_PAYLOADS } from '../../core/events.js'
import { LAUNCH_STOP_WITH_NO_PULL_REQUEST, LIFTED_ADMISSION } from '../../core/queue.js'
import { reducedTypesOf } from '../../core/reducer.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const ROOT = process.cwd()
const EVENTS_MODULE = 'scripts/core/events.ts'
const CORE_EVENTS = ['card.admitted', 'card.started', 'task.leased', 'task.completed', 'window.request', 'owner.wait.opened', 'review.recorded']
const STOP_REASONS = ['question.agent', 'question.owner', 'ladder.approval', 'witness.downgrade']

const WRITTEN_UNDER_A_TYPE_CHOSEN_AT_RUN_TIME: Record<string, { keys: string[], writer: string }> = {
  'card.planned': { keys: ['request'], writer: 'scripts/window/window-requests.ts plan(): the type is PLAN_OPS.get(op)' },
  'plan.opened': { keys: ['gate', 'request', 'version'], writer: 'scripts/window/window-requests.ts plan(): the type is PLAN_OPS.get(op)' },
  'task.expired': { keys: ['withdraw'], writer: 'scripts/core/lease.ts: the type is a parameter passed down two helpers' },
  'task.failed': { keys: ['uncounted'], writer: 'scripts/core/lease.ts failed(): the type is a parameter passed down two helpers' },
}

interface FactoryBus {
  events: Record<string, { keys: string[], complete: boolean }>
  eventsOutsideTheCatalogue: Record<string, unknown>
}

function factoryBus(): FactoryBus {
  return (JSON.parse(readFileSync(path.join(ROOT, 'contract/factory.json'), 'utf8')) as { bus: FactoryBus }).bus
}

function parsed(file: string, text: string): ParsedFile {
  return { file, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) }
}

const repository = parsedFiles(ROOT)
const catalogue = catalogueOf(repository.find(({ file }) => file === EVENTS_MODULE)!)
const scratchRoots: string[] = []
const benches: MergeBench[] = []
const ADMITTED_BY_INTAKE = 1301

function typedTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'events-catalogue-'))
  scratchRoots.push(root)
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true } }))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function measured(root: string, trees?: string[]): ReturnType<typeof writtenEvents> {
  const { files, checker } = typedReading(root, parsedFiles(root, trees))
  return writtenEvents(files, catalogue, checker)
}

const written = measured(ROOT)

afterAll(() => {
  scratchRoots.forEach(root => rmSync(root, { recursive: true, force: true }))
  benches.splice(0).forEach(made => made.close())
})

describe('the typed catalogue of bus events', () => {
  it('every bus event in contract factory json is complete', () => {
    expect(written.opaque).toEqual({})
    expect(Object.entries(written.events).filter(([, each]) => !each.complete).map(([type]) => type)).toEqual([])
    expect(factoryBus().events).toEqual(written.events)
    expect(Object.keys(written.events)).toEqual(expect.arrayContaining(CORE_EVENTS))
  })

  it('no event is written outside the catalogue', () => {
    expect(factoryBus().eventsOutsideTheCatalogue).toEqual({})
    expect(written.outsideTheCatalogue).toEqual({})
  })

  it('a writer with an undeclared payload key is refused', () => {
    const writer = parsed('scripts/core/smuggler.ts', [
      'import { TASK_LEASED } from \'./events.js\'',
      'appendEvent(db, { ts, type: TASK_LEASED, actor, cardId: null, pr: null, head: null, dedupeKey: \'k\', payload: { task_key: key, smuggled: 1 }, legacy: false })',
    ].join('\n'))
    expect(writtenEvents([writer], catalogue).refused).toEqual([{ type: 'task.leased', key: 'smuggled', file: 'scripts/core/smuggler.ts' }])
    expect(written.refused).toEqual([])
  })

  it('refuses an undeclared key a writer spreads from a typed value, which the syntax alone does not show', () => {
    const root = typedTree({ 'scripts/spread.ts': [
      'export const TASK_LEASED = \'task.leased\'',
      'interface Leased { task_key: string, smuggled: number }',
      'declare const leased: Leased',
      'declare function appendEvent(event: object): void',
      'appendEvent({ type: TASK_LEASED, payload: { ...leased, queue: \'launch\' } })',
    ].join('\n') })
    expect(measured(root, ['scripts']).refused).toEqual([{ type: 'task.leased', key: 'smuggled', file: 'scripts/spread.ts' }])
  })

  it('reads an event as incomplete while a writer spreads a payload whose keys no type bounds', () => {
    const root = typedTree({ 'scripts/open.ts': [
      'export const TASK_RENEWED = \'task.renewed\'',
      'declare const open: Record<string, unknown>',
      'declare function appendEvent(event: object): void',
      'appendEvent({ type: TASK_RENEWED, payload: { ...open, task_key: \'k\' } })',
    ].join('\n') })
    const reading = measured(root, ['scripts'])
    expect(reading.events['task.renewed']!.complete).toBe(false)
    expect(reading.opaque).toEqual({ 'task.renewed': ['scripts/open.ts:4'] })
  })

  it('refuses at write time an open payload that carries an undeclared key', () => {
    expect(declaredPayload('window.request', { kind: 'tree.cut', card: 1 })).toEqual({ kind: 'tree.cut', card: 1 })
    expect(() => declaredPayload('window.request', { kind: 'tree.cut', smuggled: 1 })).toThrow('window.request declares no payload key smuggled')
  })

  it('declares no key that no writer writes, beyond the writers whose type is chosen at run time', () => {
    expect(written.unwritten).toEqual(Object.fromEntries(Object.entries(WRITTEN_UNDER_A_TYPE_CHOSEN_AT_RUN_TIME).map(([type, { keys }]) => [type, keys])))
  })

  it('folds no type the catalogue does not declare', () => {
    const fold: Fold = () => {}
    expect(reducedTypesOf({ 'task.leased': fold })).toEqual(['task.leased'])
    expect(() => reducedTypesOf({ 'task.leased': fold, 'stray.event': fold })).toThrow('stray.event declares no payload in EVENT_PAYLOADS')
  })

  it('counts a write of an undeclared type as outside the catalogue', () => {
    const writer = parsed('scripts/core/stray.ts', 'export const STRAY = \'stray.event\'\nappendEvent(db, { type: STRAY, payload: { a: 1 } })')
    expect(Object.keys(writtenEvents([writer], catalogue).outsideTheCatalogue)).toEqual(['stray.event'])
  })

  it('keeps the stop reasons out of the event types', () => {
    expect(Object.keys(EVENT_PAYLOADS).filter(type => STOP_REASONS.includes(type))).toEqual([])
  })

  it('reads the re-versioning writer of card-bodies, so card.admitted carries the keys appendCardEvent adds', () => {
    expect(written.events['card.admitted']!.keys).toEqual(expect.arrayContaining(['cardVersion', 'prevAdmissionId', 'prevTextSha', 'plan']))
    expect(factoryBus().events['card.admitted']!.keys).toEqual(expect.arrayContaining(['cardVersion', 'prevAdmissionId', 'prevTextSha', 'plan']))
  })

  it('lifts a launch stop on a card intake admitted through appendCardEvent, versioned keys and plan link included', () => {
    const made = mergeBench()
    benches.push(made)
    const ts = made.clock.now().toISOString()
    const admission = { card: `#${ADMITTED_BY_INTAKE} lifted`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], text: `card: #${ADMITTED_BY_INTAKE} lifted`, plan: { plan: 'P-1', item: 'a' }, admission: `admission-${ADMITTED_BY_INTAKE}` }
    expect(appendCardEvent(made.db, 'worker:intake:window', { type: CARD_ADMITTED, cardId: ADMITTED_BY_INTAKE, ts, dedupeKey: `${CARD_ADMITTED}:${ADMITTED_BY_INTAKE}`, payload: admission })).toBe(true)
    appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: ADMITTED_BY_INTAKE, pr: null, head: null, dedupeKey: `${LAUNCH_STOP_WITH_NO_PULL_REQUEST}${ADMITTED_BY_INTAKE}`, payload: { reason: 'question.agent', detail: 'asks', widen: [] }, legacy: false })
    const stop = (made.db.prepare(`SELECT max(id) AS id FROM events WHERE type = '${CARD_STOPPED}'`).get() as { id: number }).id
    made.tick()
    made.tick()
    expect(eventsOf(made.db, CARD_ADMITTED)).toEqual([
      expect.objectContaining({ cardVersion: 1, prevAdmissionId: null, prevTextSha: null }),
      expect.objectContaining({ cardVersion: 1, plan: { plan: 'P-1', item: 'a' }, admission: `${LIFTED_ADMISSION}:${stop}` }),
    ])
  })
})
