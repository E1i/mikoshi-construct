import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const CARD_DOMAIN_READERS = ['scripts/core/card-automaton.ts', 'scripts/core/card-bodies.ts', 'scripts/core/card-hold.ts', 'scripts/intake/admissions.ts']
const EVENTS_IN_SQL = /\b(?:FROM|JOIN)\s+"?events\b/i
const EVENTS_QUERY = /from '(?:\.\/|\.\.\/core\/)events-query\.js'/
const INJECTED_BUS_CONTRACT = /import type \{[^}]*\bBusContract\b[^}]*\} from '\.\/bus-contract\.js'/
const READERS_GIVEN_THE_BUS = ['scripts/core/card-automaton.ts', 'scripts/core/card-bodies.ts']
const readsThroughTheBus = (file: string): boolean => (READERS_GIVEN_THE_BUS.includes(file) ? INJECTED_BUS_CONTRACT : EVENTS_QUERY).test(readFileSync(path.join(ROOT, file), 'utf8'))

describe('the card domain reads events through the bus', () => {
  it('card-automaton, card-bodies, card-hold and admissions name the events table in no SQL', () => {
    const naming = CARD_DOMAIN_READERS.filter(file => EVENTS_IN_SQL.test(readFileSync(path.join(ROOT, file), 'utf8')))
    expect(naming).toEqual([])
  })

  it('each of them imports the events query of the bus, or takes the bus contract from its composition root', () => {
    const without = CARD_DOMAIN_READERS.filter(file => !readsThroughTheBus(file))
    expect(without).toEqual([])
  })

  it('card-automaton keeps no copy of lastEventId of its own', () => {
    expect(readFileSync(path.join(ROOT, 'scripts/core/card-automaton.ts'), 'utf8')).not.toMatch(/function lastEventId\b/)
  })
})
