import type { VersionedSection } from '../../contract/factory-bump.js'
import type { WaitTerm } from '../../core/events.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { sectionVerdict, VERSIONED_SECTIONS } from '../../contract/factory-bump.js'
import { cardSection, cardWaitsCode, GENERATED_WAITS_FROM } from '../../contract/factory/card.js'
import { catalogueOf, eventsCode, GENERATED_EVENTS_FROM } from '../../contract/factory/payloads.js'
import { CARD_WAITS, EVENT_PAYLOADS } from '../../core/events.js'

const ROOT = process.cwd()
const EVENTS_MODULE = 'scripts/core/events.ts'
const SEEDED_ENTRY = 'seededByTheCompatibilityTest'

interface RecordedFactory {
  bus: { events: Record<string, { keys: string[] }> }
  card: { waits: Record<string, WaitTerm> }
  [section: string]: unknown
}

function recordedFactory(): RecordedFactory {
  return JSON.parse(readFileSync(path.join(ROOT, 'contract/factory.json'), 'utf8')) as RecordedFactory
}

const eventsText = readFileSync(path.join(ROOT, EVENTS_MODULE), 'utf8')
const catalogue = catalogueOf({ file: EVENTS_MODULE, source: ts.createSourceFile(EVENTS_MODULE, eventsText, ts.ScriptTarget.Latest, true) })

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

describe('event and card field code generated from the contract', () => {
  it('event and card field code equals what the contract generates', () => {
    const factory = recordedFactory()

    expect(occurrences(eventsText, GENERATED_EVENTS_FROM)).toBe(1)
    expect(eventsText.slice(eventsText.indexOf(GENERATED_EVENTS_FROM))).toBe(eventsCode(factory.bus.events, catalogue.names))
    expect(occurrences(eventsText, GENERATED_WAITS_FROM)).toBe(1)
    expect(eventsText).toContain(cardWaitsCode(factory.card.waits))
  })

  it('generates the catalogue the code reads, so the contract and the runtime agree on every type and key', () => {
    const factory = recordedFactory()

    expect(Object.fromEntries(Object.entries(EVENT_PAYLOADS).map(([type, keys]) => [type, [...keys].sort()]))).toEqual(Object.fromEntries(Object.entries(factory.bus.events).map(([type, { keys }]) => [type, keys])))
    expect(factory.card.waits).toEqual(CARD_WAITS)
    expect(cardSection(ROOT).waits).toEqual(factory.card.waits)
  })

  it('a contract change shows as a difference in the generated code', () => {
    const factory = recordedFactory()
    const grown = { ...factory.bus.events, 'task.leased': { keys: [...factory.bus.events['task.leased']!.keys, 'seeded'] } }

    expect(eventsCode(grown, catalogue.names)).not.toBe(eventsCode(factory.bus.events, catalogue.names))
    expect(cardWaitsCode({ ...factory.card.waits, launch: { lifter: 'bus', deadlineMinutes: 31 } })).not.toBe(cardWaitsCode(factory.card.waits))
    expect(() => eventsCode({ 'stray.event': { keys: [] } }, catalogue.names)).toThrow('stray.event, which no constant')
  })
})

describe('the versions of the contracts', () => {
  it('every contract has a version and a compatibility test', () => {
    const factory = recordedFactory()

    for (const section of Object.keys(VERSIONED_SECTIONS) as VersionedSection[]) {
      const recorded = factory[section] as Record<string, unknown>
      const key = VERSIONED_SECTIONS[section]
      const version = recorded[key] as number
      const changed = { ...recorded, [SEEDED_ENTRY]: true }

      expect(Number.isInteger(version) && version >= 1, `${section}.${key}`).toBe(true)
      expect(sectionVerdict(section, recorded, recorded).red, `${section} unchanged`).toBe(false)
      expect(sectionVerdict(section, recorded, changed).red, `${section} changed without a grown version`).toBe(true)
      expect(sectionVerdict(section, recorded, { ...changed, [key]: version + 1 }).red, `${section} changed with a grown version`).toBe(false)
      expect(sectionVerdict(section, recorded, { ...recorded, [key]: version - 1 }).red, `${section} version went down`).toBe(true)
    }
  })
})
