import type { VersionedSection } from '../../scripts/contract/factory-bump.js'
import type { Factory } from '../../scripts/contract/factory.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { factoryGate } from '../../scripts/contract/bump.js'
import { factoryVerdicts, sectionVerdict, VERSIONED_SECTIONS } from '../../scripts/contract/factory-bump.js'
import { cardSection } from '../../scripts/contract/factory/card.js'
import { NODES_VERSION } from '../../scripts/contract/factory/nodes.js'
import { PORTS_VERSION } from '../../scripts/contract/factory/ports.js'
import { CARD_VERSION, CARD_VERSION_KEY, UNRECORDED_VERSION } from '../../scripts/core/bus-version.js'
import { CONTRACT_FIELDS, CONTRACTS } from '../../scripts/intake/card-contract.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const RECORDED = path.join(REPO_ROOT, 'contract', 'factory.json')
const BASE_TAG = 'v0.46.0'

const CLIENT_CONTRACT_MODULE = 'scripts/ports/client/contract.ts'
const CLIENT_ADAPTER_AT_THE_BASE_OF_PR_1405 = 'interface ClientAdapter { readonly id: string; readonly capabilities: Capabilities; invocation: (spec: SessionSpec) => Invocation | Refusal; reading: (place: SessionPlace) => SessionReading; readBudget: (home: string, session: string) => ReadBudget; models: () => ModelOffer[]; modelFor: (role: Role, effort: Effort | null, wanted: ModelChoice) => ModelPick | Refusal; processes: ClientProcesses; ownSession: (env: NodeJS.ProcessEnv) => string | null; }'
const CLIENT_ADAPTER_AT_THE_HEAD_OF_PR_1405 = 'interface ClientAdapter { readonly id: string; readonly capabilities: Capabilities; invocation: (spec: SessionSpec) => Invocation | Refusal; reading: (place: SessionPlace) => SessionReading; readBudget: (place: SessionPlace) => ReadBudget; models: () => ModelOffer[] | null; modelFor: (role: Role, effort: Effort | null, wanted: ModelChoice) => ModelPick | Refusal; processes: ClientProcesses; ownSession: (env: NodeJS.ProcessEnv) => string | null; }'

function recordedFactory(): Factory {
  return JSON.parse(readFileSync(RECORDED, 'utf8')) as Factory
}

function portsEntryOfPr1405(clientAdapter: string): Record<string, unknown> {
  return { [CLIENT_CONTRACT_MODULE]: { constants: [], functions: {}, reexports: [], types: { ClientAdapter: clientAdapter } } }
}

const CHANGES: Record<VersionedSection, (factory: Factory) => void> = {
  bus: (factory) => {
    factory.bus.tables.events = [...factory.bus.tables.events!, 'seeded_column']
  },
  card: (factory) => {
    factory.card.fields = { ...factory.card.fields, seededField: 'string' }
  },
  ports: (factory) => {
    const [first] = Object.keys(factory.ports.modules)
    factory.ports.modules[first!]!.functions.seeded = '(): void'
  },
  nodes: (factory) => {
    factory.nodes.declared.merge!.understands = { ...factory.nodes.declared.merge!.understands, card: [] }
  },
}

function changedHead(section: VersionedSection, growBy = 0): Factory {
  const head = recordedFactory()
  CHANGES[section](head)
  const versioned = head[section] as unknown as Record<string, number>
  versioned[VERSIONED_SECTIONS[section]]! += growBy
  return head
}

function verdictOf(section: VersionedSection, head: Factory): ReturnType<typeof sectionVerdict> {
  return factoryVerdicts(recordedFactory(), head).find(verdict => verdict.section === section)!
}

describe('the factory section versions', () => {
  it('a changed bus section without a grown version is red', () => {
    const verdict = verdictOf('bus', changedHead('bus'))

    expect(verdict.red).toBe(true)
    expect(verdict.line).toContain('tables.events')
    expect(verdict.line).toContain('busVersion stayed')
    expect(factoryGate(BASE_TAG, recordedFactory(), changedHead('bus')).red).toBe(true)
  })

  it('a changed card section without a grown version is red', () => {
    const verdict = verdictOf('card', changedHead('card'))

    expect(verdict.red).toBe(true)
    expect(verdict.line).toContain('fields.seededField')
    expect(verdict.line).toContain(`cardVersion stayed ${CARD_VERSION}`)
  })

  it('a changed ports section without a grown version is red', () => {
    const verdict = verdictOf('ports', changedHead('ports'))

    expect(verdict.red).toBe(true)
    expect(verdict.line).toContain('portsVersion stayed')
  })

  it('a changed nodes section without a grown version is red', () => {
    const verdict = verdictOf('nodes', changedHead('nodes'))

    expect(verdict.red).toBe(true)
    expect(verdict.line).toContain('declared.merge')
  })

  it('a changed section with a grown version passes', () => {
    for (const section of Object.keys(VERSIONED_SECTIONS) as VersionedSection[]) {
      const verdict = verdictOf(section, changedHead(section, 1))

      expect(verdict.red, section).toBe(false)
      expect(verdict.line, section).toContain('grew from')
    }
    const grown = changedHead('bus', 1)

    expect(factoryGate(BASE_TAG, recordedFactory(), grown)).toEqual({ red: false, lines: expect.arrayContaining([`[contract:bump] contract/factory.json sections against ${BASE_TAG}:`]) as unknown })
    expect(factoryVerdicts(recordedFactory(), recordedFactory()).every(verdict => !verdict.red)).toBe(true)
  })

  it('the card section holds the fields of the card contract', () => {
    const card = cardSection(REPO_ROOT)

    expect(card.cardVersion).toBe(CARD_VERSION)
    expect(card.versionRecord).toBe(`card.admitted payload.${CARD_VERSION_KEY}`)
    expect(card.contracts).toEqual(CONTRACT_FIELDS)
    for (const contract of CONTRACTS) {
      for (const field of CONTRACT_FIELDS[contract])
        expect(Object.keys(card.fields), `${contract}.${field}`).toContain(field)
    }
    expect(card.fields).toMatchObject({ touches: 'string[]', creates: 'string[]', witnesses: 'string[]', runs: 'string[]', contour: 'string', who: 'string' })
    expect(recordedFactory().card).toEqual(JSON.parse(JSON.stringify(card)))
  })

  it('the ports change of PR #1405 without a grown version is red', () => {
    const verdict = sectionVerdict('ports', portsEntryOfPr1405(CLIENT_ADAPTER_AT_THE_BASE_OF_PR_1405), portsEntryOfPr1405(CLIENT_ADAPTER_AT_THE_HEAD_OF_PR_1405))

    expect(verdict.red).toBe(true)
    expect(verdict.line).toContain(`${CLIENT_CONTRACT_MODULE}.types`)
    expect(verdict.line).toContain(`portsVersion stayed ${UNRECORDED_VERSION}`)
  })

  it('a section with no version key reads as version 1, so an older record compares against version 2', () => {
    const base = portsEntryOfPr1405(CLIENT_ADAPTER_AT_THE_BASE_OF_PR_1405)

    expect(sectionVerdict('ports', base, { portsVersion: 2, modules: portsEntryOfPr1405(CLIENT_ADAPTER_AT_THE_HEAD_OF_PR_1405) }).red).toBe(false)
    expect(sectionVerdict('ports', base, { portsVersion: 1, modules: base }).red).toBe(true)
  })

  it('a section new since the base passes, a removed one and a version that went down are red', () => {
    const recorded = recordedFactory()

    expect(sectionVerdict('card', undefined, recorded.card)).toMatchObject({ red: false, line: `card: new since the base, at cardVersion ${CARD_VERSION}` })
    expect(sectionVerdict('card', recorded.card, undefined).red).toBe(true)
    expect(sectionVerdict('nodes', { ...recorded.nodes, nodesVersion: 3 }, recorded.nodes).line).toContain('went down from 3')
    expect(sectionVerdict('nodes', undefined, undefined).red).toBe(false)
    expect(sectionVerdict('bus', recorded.bus, recorded.bus)).toEqual({ section: 'bus', red: false, line: `bus: unchanged, busVersion ${recorded.bus.busVersion}` })
  })

  it('the ports reshape into { portsVersion, modules } passes against the unversioned record of main only because portsVersion grew past 1', () => {
    const recorded = recordedFactory()

    expect(recorded.ports.portsVersion).toBe(PORTS_VERSION)
    expect(recorded.nodes.nodesVersion).toBe(NODES_VERSION)
    expect(PORTS_VERSION).toBeGreaterThan(UNRECORDED_VERSION)
    expect(sectionVerdict('ports', recorded.ports.modules, recorded.ports).red).toBe(false)
    expect(sectionVerdict('ports', recorded.ports.modules, { ...recorded.ports, portsVersion: UNRECORDED_VERSION }).red).toBe(true)
  })

  it('a base tag that carries no factory record compares nothing', () => {
    expect(factoryGate(BASE_TAG, null, recordedFactory())).toEqual({ red: false, lines: [`[contract:bump] ${BASE_TAG} carries no contract/factory.json, so no section version of it is compared`] })
  })
})
