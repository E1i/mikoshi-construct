import { describe, expect, it } from 'vitest'
import { witnessFieldRefusals } from '../../../src/card/witness-fields.js'
import { cardRunsOf, LayerWithoutTests } from '../../ci/card-runs.js'

const CATALOG = {
  testLayers: new Map([
    ['tests/a.test.ts', ['src']],
    ['tests/b.test.ts', ['src', 'core']],
    ['scripts/tests/core/c.test.ts', ['core']],
    ['scripts/tests/bus/d.test.ts', ['bus']],
  ]),
  moduleLayers: new Map([
    ['src/a.ts', ['src']],
    ['src/deep/b.ts', ['src']],
    ['scripts/core/c.ts', ['core']],
    ['scripts/release/e.ts', ['release']],
  ]),
}

describe('the runs of a card, read from the check catalog', () => {
  it('a card with no runs field gets the tests of the layers of its touches', () => {
    expect(cardRunsOf({ touches: ['scripts/core/c.ts'], runs: [], masks: [] }, CATALOG)).toEqual({ layers: ['core'], paths: [], tests: ['scripts/tests/core/c.test.ts', 'tests/b.test.ts'] })
  })

  it('a glob touch reads the layers of every module under it', () => {
    expect(cardRunsOf({ touches: ['src/deep/**'], runs: [], masks: [] }, CATALOG)).toEqual({ layers: ['src'], paths: [], tests: ['tests/a.test.ts', 'tests/b.test.ts'] })
  })

  it('a touched test the catalog knows runs, and adds no layer of its own', () => {
    expect(cardRunsOf({ touches: ['src/a.ts', 'scripts/tests/bus/d.test.ts'], runs: [], masks: [] }, CATALOG)).toEqual({ layers: ['src'], paths: [], tests: ['scripts/tests/bus/d.test.ts', 'tests/a.test.ts', 'tests/b.test.ts'] })
  })

  it('a layer entry expands to the files of that layer by the catalog, and does not hide a touch outside it', () => {
    expect(cardRunsOf({ touches: ['scripts/core/c.ts'], runs: [], masks: ['bus'] }, CATALOG)).toEqual({ layers: ['bus', 'core'], paths: [], tests: ['scripts/tests/bus/d.test.ts', 'scripts/tests/core/c.test.ts', 'tests/b.test.ts'] })
  })

  it('an explicit path the layers cover is folded in, and one they do not cover is kept apart', () => {
    expect(cardRunsOf({ touches: [], runs: ['scripts/tests/core/c.test.ts', 'tests/new.test.ts'], masks: ['core'] }, CATALOG)).toEqual({ layers: ['core'], paths: ['tests/new.test.ts'], tests: ['scripts/tests/core/c.test.ts', 'tests/b.test.ts', 'tests/new.test.ts'] })
  })

  it('a glob stays apart unless the layers cover every test under it', () => {
    expect(cardRunsOf({ touches: [], runs: ['scripts/tests/core/**'], masks: ['core'] }, CATALOG)).toMatchObject({ paths: [] })
    expect(cardRunsOf({ touches: [], runs: ['tests/**'], masks: ['core'] }, CATALOG)).toMatchObject({ paths: ['tests/**'] })
    expect(cardRunsOf({ touches: [], runs: ['tests/none/**'], masks: ['core'] }, CATALOG)).toMatchObject({ paths: ['tests/none/**'] })
  })

  it('a card with a runs field keeps a touch one run covers from adding its layers, and reads full for a touch no layer holds', () => {
    expect(cardRunsOf({ touches: ['src/a.ts'], runs: ['tests/a.test.ts'], masks: [] }, CATALOG)).toEqual({ layers: [], paths: ['tests/a.test.ts'], tests: ['tests/a.test.ts'] })
    expect(cardRunsOf({ touches: ['CONTRIBUTING.md'], runs: ['tests/a.test.ts'], masks: [] }, CATALOG)).toEqual({ full: true, why: expect.stringContaining('CONTRIBUTING.md') })
  })

  it('a touch with declared path readers takes the layers of those readers, as selectRun does', () => {
    const catalog = {
      testLayers: new Map([...CATALOG.testLayers, ['tests/materialize.test.ts', ['src']], ['scripts/tests/bus/policy.test.ts', ['bus']], ['tests/contract/c.test.ts', ['contract']]]),
      moduleLayers: new Map([...CATALOG.moduleLayers, ['src/materialize/templates.ts', ['src']], ['scripts/policy/policy.ts', ['bus']], ['scripts/contract/ratchet.ts', ['contract']]]),
    }
    expect(cardRunsOf({ touches: ['templates/**'], runs: [], masks: [] }, catalog)).toMatchObject({ layers: ['src'] })
    expect(cardRunsOf({ touches: ['templates/base/x.eta'], runs: [], masks: [] }, catalog)).toMatchObject({ layers: ['src'] })
    expect(cardRunsOf({ touches: ['contract/ratchet.json'], runs: [], masks: [] }, catalog)).toMatchObject({ layers: ['contract'] })
  })

  it('an unknown layer is refused and an empty catalog reads full rather than nothing', () => {
    expect(witnessFieldRefusals('runs: ["layer:no-such-layer"]')).toEqual([expect.stringContaining('\'layer:no-such-layer\' names no layer')])
    expect(witnessFieldRefusals('runs: ["layer:core", "layer:bus:answer"]')).toEqual([])
    const emptyTests = { testLayers: new Map(), moduleLayers: CATALOG.moduleLayers }
    const emptyModules = { testLayers: CATALOG.testLayers, moduleLayers: new Map() }
    expect(cardRunsOf({ touches: ['src/a.ts'], runs: [], masks: [] }, emptyTests)).toEqual({ full: true, why: expect.stringContaining('empty') })
    expect(cardRunsOf({ touches: [], runs: [], masks: ['core'] }, emptyModules)).toEqual({ full: true, why: expect.stringContaining('empty') })
  })

  it('a touch on a non-code file in a layer folder takes the layers of the code beside it, not the full run', () => {
    const map = { files: { 'scripts/core/c.ts': 'core' }, folders: { 'scripts/core/': 'core' } }
    expect(cardRunsOf({ touches: ['scripts/core/header.md'], runs: [], masks: [] }, CATALOG, map)).toEqual({ layers: ['core'], paths: [], tests: ['scripts/tests/core/c.test.ts', 'tests/b.test.ts'] })
  })

  it('whatever cannot name a test reads full with its reason', () => {
    expect(cardRunsOf({ touches: ['src/a.ts', 'CONTRIBUTING.md'], runs: [], masks: [] }, CATALOG)).toEqual({ full: true, why: expect.stringContaining('CONTRIBUTING.md') })
    expect(() => cardRunsOf({ touches: ['scripts/release/e.ts'], runs: [], masks: [] }, CATALOG)).toThrow(LayerWithoutTests)
    expect(() => cardRunsOf({ touches: [], runs: [], masks: ['release'] }, CATALOG)).toThrow(LayerWithoutTests)
    expect(cardRunsOf({ touches: [], runs: [], masks: [] }, CATALOG)).toEqual({ full: true, why: expect.stringContaining('no touch') })
  })
})
