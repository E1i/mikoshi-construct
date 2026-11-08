import type { ParsedFile } from '../../contract/factory/walk.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { catalogueOf, writtenEvents } from '../../contract/factory/payloads.js'
import { parsedFiles } from '../../contract/factory/walk.js'
import { catalogued, EVENT_PAYLOADS } from '../../core/events.js'

const ROOT = process.cwd()
const EVENTS_MODULE = 'scripts/core/events.ts'
const CORE_EVENTS = ['card.admitted', 'card.started', 'task.leased', 'task.completed', 'window.request', 'owner.wait.opened', 'review.recorded']

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

describe('the typed catalogue of bus events', () => {
  it('every bus event in contract factory json is complete', () => {
    const { events } = factoryBus()
    expect(Object.keys(events).sort()).toEqual(Object.keys(EVENT_PAYLOADS).sort())
    expect(Object.entries(events).filter(([, written]) => !written.complete).map(([type]) => type)).toEqual([])
    for (const [type, keys] of Object.entries(EVENT_PAYLOADS))
      expect(events[type]!.keys).toEqual([...keys].sort())
    expect(Object.keys(events)).toEqual(expect.arrayContaining(CORE_EVENTS))
  })

  it('no event is written outside the catalogue', () => {
    expect(factoryBus().eventsOutsideTheCatalogue).toEqual({})
    expect(writtenEvents(repository, catalogue).outsideTheCatalogue).toEqual({})
  })

  it('a writer with an undeclared payload key is refused', () => {
    const writer = parsed('scripts/core/smuggler.ts', [
      'import { TASK_LEASED } from \'./events.js\'',
      'appendEvent(db, { ts, type: TASK_LEASED, actor, cardId: null, pr: null, head: null, dedupeKey: \'k\', payload: { task_key: key, smuggled: 1 }, legacy: false })',
    ].join('\n'))
    expect(writtenEvents([writer], catalogue).refused).toEqual([{ type: 'task.leased', key: 'smuggled', file: 'scripts/core/smuggler.ts' }])
    expect(writtenEvents(repository, catalogue).refused).toEqual([])
  })

  it('refuses a helper envelope only on the keys of its nested payload', () => {
    const writer = parsed('scripts/core/envelope.ts', 'observation(ts, \'main.advanced\', { cardId: null, pr: null, head: null, dedupeKey: k, payload: { sha, touches_mechanics: true, extra: 1 } })')
    expect(writtenEvents([writer], catalogue).refused.map(({ key }) => key)).toEqual(['extra'])
  })

  it('counts a write of an undeclared type as outside the catalogue', () => {
    const writer = parsed('scripts/core/stray.ts', 'export const STRAY = \'stray.event\'\nappendEvent(db, { type: STRAY, payload: { a: 1 } })')
    expect(Object.keys(writtenEvents([writer], catalogue).outsideTheCatalogue)).toEqual(['stray.event'])
  })

  it('lets nothing fold a type the catalogue does not declare', () => {
    expect(catalogued('task.leased')).toBe('task.leased')
    expect(() => catalogued('stray.event')).toThrow('declares no payload in EVENT_PAYLOADS')
  })

  it('keeps the stop reasons out of the event types', () => {
    expect(Object.keys(EVENT_PAYLOADS).filter(type => ['question.agent', 'question.owner', 'ladder.approval', 'witness.downgrade'].includes(type))).toEqual([])
  })
})
